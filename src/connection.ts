// Herdr not running, not installed, crashed or incompatible: telling these apart, and starting the
// server in the background. No vscode imports (tested with fake herdr binaries).
//
// Verified against herdr 0.9.1:
//  - `herdr status server --json` reports {running, compatible, protocol, version, socket, session, ...}
//    and honors HERDR_SOCKET_PATH / HERDR_SESSION / --session, so it is the authoritative check.
//  - `herdr server` runs the headless server in the foreground; spawned detached it outlives its parent
//    (and VS Code). After a crash its socket file stays behind; status says not running and a new
//    server starts fine over it.
//  - Sessions are separated by session NAME, not socket path: a second server for the same session
//    (even on another socket) restores and then overwrites that session's state. So never start a
//    server unless status says none is running for this session.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { expandHome } from './herdrClient';
import { sleep } from './format';
import { HERDR_PROTOCOL } from './herdrTypes';
import { findTool } from './tools';

export function resolveBinary(override?: string): string {
  if (override) return expandHome(override);
  return findTool('herdr');
}

/** The binary exists (an absolute path that is there, or a bare name found on PATH). */
export function binaryFound(bin: string): boolean {
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

/** `<anything>/sessions/<name>/herdr.sock` is named session <name>'s socket. */
export function sessionOfSocket(socket: string): string | undefined {
  const m = /[/\\]sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(socket);
  return m?.[1];
}

/**
 * The environment herdr commands need so they target the same session/socket the extension uses.
 * A named session's socket also selects that session: Herdr keeps state per session NAME, so a server
 * started on another socket of the same session would share (and overwrite) its state.
 */
export function herdrEnv(socketOverride?: string): NodeJS.ProcessEnv {
  if (!socketOverride) return { ...process.env };
  const session = sessionOfSocket(socketOverride);
  return { ...process.env, HERDR_SOCKET_PATH: socketOverride, ...(session && { HERDR_SESSION: session }) };
}

export interface ServerStatus {
  running: boolean;
  compatible?: boolean | null;
  protocol?: number | null;
  version?: string | null;
  socket?: string;
  session?: string | null;
  restart_needed?: boolean;
}

/** `herdr status server --json`; undefined when the command can't run or answer. */
export function serverStatus(bin: string, env: NodeJS.ProcessEnv): Promise<ServerStatus | undefined> {
  return new Promise((resolve) =>
    execFile(bin, ['status', 'server', '--json'], { env, timeout: 5000 }, (_err, out) => {
      try {
        const s = JSON.parse(out.toString());
        resolve(typeof s?.running === 'boolean' ? s : undefined);
      } catch {
        resolve(undefined);
      }
    }),
  );
}

export type DownReason = 'not-installed' | 'not-running' | 'crashed' | 'incompatible' | 'unreachable';

export interface Diagnosis {
  reason: DownReason;
  /** The socket the extension connects to. */
  socket: string;
  /** It comes from the herdr.socketPath setting. */
  customSocket: boolean;
  /** The herdr binary the extension runs. */
  binary: string;
  version?: string;
  protocol?: number;
  /** Extra detail, e.g. the connection error. */
  detail?: string;
}

/** Why the extension can't reach Herdr. `error` is the failed request's error, if any. */
export async function diagnose(bin: string, socket: string, customSocket: boolean, env: NodeJS.ProcessEnv, error?: unknown): Promise<Diagnosis> {
  const base = { socket, customSocket, binary: bin };
  if (!binaryFound(bin)) return { ...base, reason: 'not-installed' };
  const st = await serverStatus(bin, env);
  const detail = error instanceof Error ? error.message : error ? String(error) : undefined;
  if (!st) return { ...base, reason: 'unreachable', detail: detail ?? '`herdr status server` did not answer' };
  if (!st.running) return { ...base, reason: fs.existsSync(socket) ? 'crashed' : 'not-running' };
  const meta = { version: st.version ?? undefined, protocol: st.protocol ?? undefined };
  if (st.compatible === false || (typeof st.protocol === 'number' && st.protocol !== HERDR_PROTOCOL))
    return { ...base, ...meta, reason: 'incompatible' };
  return { ...base, ...meta, reason: 'unreachable', detail };
}

/**
 * The environment to start the server with: like a terminal's, not VS Code's. Panes inherit it, so:
 *  - drop VS Code / Electron variables (ELECTRON_RUN_AS_NODE breaks Electron apps started from a pane;
 *    __CFBundleIdentifier makes macOS attribute pane processes to VS Code);
 *  - stop Kiro's shell integration from wrapping every pane shell in its `kiro-cli-term` pty, which hides
 *    agents from Herdr's detection. A server started from a Kiro-wrapped terminal inherits Q_TERM and is
 *    left alone; one started from VS Code has none, so set Kiro's own opt-out, Q_TERM_DISABLED (verified:
 *    `kiro-cli _ should-figterm-launch` then exits 1, "don't launch").
 */
export function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(VSCODE_|ELECTRON_|APPLICATION_INSIGHTS|CHROME_|ORIGINAL_XDG_)/.test(k) || k === '__CFBundleIdentifier') continue;
    if ((k === 'TERM_PROGRAM' || k === 'TERM_PROGRAM_VERSION') && /vscode/i.test(env.TERM_PROGRAM ?? '')) continue;
    out[k] = v;
  }
  if (!out.Q_TERM) out.Q_TERM_DISABLED = '1';
  return out;
}

export interface StartResult {
  ok: boolean;
  /** It was already running: nothing was started. */
  already?: boolean;
  error?: string;
}

/**
 * Take `lockFile` (created exclusively). A lock older than `staleMs` is from a start that died: taken over.
 * False when someone else holds it.
 */
function takeLock(lockFile: string, staleMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        return true; // can't lock here (read-only folder): start without one, as before locks
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs < staleMs) {
          return false;
        }
        fs.rmSync(lockFile, { force: true });
      } catch {
        // gone meanwhile: try again
      }
    }
  }
  return false;
}

/**
 * Start the headless server in the background (detached: it keeps running after VS Code quits) and
 * wait until it answers. Refuses to start a second server for a session that already has one. With `lockFile`
 * (one per session, shared by every editor window), only one window starts it: the others wait for that one.
 */
export async function startServer(bin: string, env: NodeJS.ProcessEnv, logFile: string, timeoutMs = 15_000, lockFile?: string): Promise<StartResult> {
  if (!binaryFound(bin)) return { ok: false, error: `herdr not found (${bin})` };
  const before = await serverStatus(bin, env);
  if (before?.running) return { ok: true, already: true };
  // A custom socket that isn't a named session's belongs to whichever session HERDR_SESSION (or the default)
  // selects. If that session already runs on its own socket, a second server would share its state: refuse.
  if (env.HERDR_SOCKET_PATH && !sessionOfSocket(env.HERDR_SOCKET_PATH)) {
    const { HERDR_SOCKET_PATH: _custom, ...sessionEnv } = env;
    const other = await serverStatus(bin, sessionEnv);
    if (other?.running)
      return {
        ok: false,
        error: `Herdr is already running for this session at ${other.socket ?? 'its default socket'}; starting another server on ${env.HERDR_SOCKET_PATH} would share its state. Point herdr.socketPath at that socket, or clear the setting.`,
      };
  }

  if (lockFile && !takeLock(lockFile, timeoutMs + 5000)) {
    return waitForOtherStart(bin, env, lockFile, timeoutMs);
  }
  try {
    return await spawnServer(bin, env, logFile, timeoutMs);
  } finally {
    if (lockFile) {
      fs.rmSync(lockFile, { force: true });
    }
  }
}

/** Another window is starting this session's server: wait for it instead of starting a second one. */
async function waitForOtherStart(bin: string, env: NodeJS.ProcessEnv, lockFile: string, timeoutMs: number): Promise<StartResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if ((await serverStatus(bin, env))?.running) {
      return { ok: true, already: true };
    }
    if (!fs.existsSync(lockFile)) {
      return { ok: false, error: 'another editor window tried to start Herdr and it didn\'t come up' };
    }
  }
  return { ok: false, error: `another editor window is starting Herdr; it didn't come up within ${Math.round(timeoutMs / 1000)}s` };
}

async function spawnServer(bin: string, env: NodeJS.ProcessEnv, logFile: string, timeoutMs: number): Promise<StartResult> {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  let exited: number | null | undefined;
  try {
    const proc = spawn(bin, ['server'], { detached: true, stdio: ['ignore', fd, fd], env: serverEnv(env) });
    proc.on('exit', (code) => (exited = code));
    proc.on('error', (e) => {
      exited = -1;
      fs.appendFileSync(logFile, `\n[herdr cockpit] could not start ${bin}: ${e.message}\n`);
    });
    proc.unref();
  } finally {
    fs.closeSync(fd);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if (exited !== undefined) {
      // It may have exited because a server for this session came up meanwhile (started elsewhere): that's fine.
      if ((await serverStatus(bin, env))?.running) {
        return { ok: true, already: true };
      }
      return { ok: false, error: `herdr server exited (${exited ?? 'signal'}); see ${logFile}` };
    }
    if ((await serverStatus(bin, env))?.running) return { ok: true };
  }
  return { ok: false, error: `herdr server didn't come up within ${Math.round(timeoutMs / 1000)}s; see ${logFile}` };
}

/** Wait before the next reconnect attempt: 1.5s, then backing off to 10s. */
export function backoffDelay(failures: number): number {
  return Math.min(10_000, 1500 * 2 ** Math.max(0, failures - 1));
}
