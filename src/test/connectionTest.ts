// Herdr not installed / not running / crashed / incompatible, and starting the server, against fake
// `herdr` executables that answer like the real CLI (`herdr status server --json`, `herdr server`).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backoffDelay, binaryFound, diagnose, herdrEnv, serverEnv, serverStatus, sessionOfSocket, startServer } from '../connection';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-conn-'));
const state = path.join(dir, 'state.json');
const setState = (s: object) => fs.writeFileSync(state, JSON.stringify(s));

/**
 * A fake herdr. `status server --json` prints state.json. `server` behaves per state.json's `server`:
 * "up" marks running and stays alive, "exit" exits at once, "hang" stays alive without coming up.
 */
const fake = path.join(dir, 'herdr');
fs.writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require('fs'); const state = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(state, 'utf8'));
const args = process.argv.slice(2).join(' ');
if (args === 'status server --json') {
  if (s.statusBroken) { console.log('not json'); process.exit(2); }
  // With a custom socket, report that socket; without, the session's default one (s.defaultRunning).
  const running = process.env.HERDR_SOCKET_PATH ? !!s.running : !!(s.defaultRunning ?? s.running);
  console.log(JSON.stringify({ running, protocol: s.protocol ?? null, version: s.version ?? null, compatible: s.compatible ?? null, socket: process.env.HERDR_SOCKET_PATH || '/default.sock' }));
} else if (args === 'server') {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'server-started'))}, String(process.pid));
  if (s.server === 'exit') process.exit(3);
  if (s.server === 'up') fs.writeFileSync(state, JSON.stringify({ ...s, running: true, protocol: 22 }));
  setInterval(() => {}, 1000);
} else process.exit(64);
`,
  { mode: 0o755 },
);
const env = herdrEnv();
const sock = path.join(dir, 'herdr.sock');
const startedFlag = path.join(dir, 'server-started');
const killStarted = () => {
  try {
    process.kill(Number(fs.readFileSync(startedFlag, 'utf8')));
  } catch {
    // already gone
  }
  fs.rmSync(startedFlag, { force: true });
};

(async () => {
  // backoff
  assert.deepStrictEqual([1, 2, 3, 4, 5, 12].map(backoffDelay), [1500, 3000, 6000, 10000, 10000, 10000]);
  console.log('✓ reconnect backoff');

  // binary lookup
  assert.strictEqual(binaryFound(path.join(dir, 'missing-herdr')), false);
  assert.strictEqual(binaryFound(fake), true);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  assert.strictEqual(binaryFound('herdr'), true, 'bare name found on PATH');
  process.env.PATH = savedPath;
  console.log('✓ binary lookup');

  // diagnosis
  const why = (bin = fake, error?: unknown) => diagnose(bin, sock, false, env, error).then((d) => d.reason);
  assert.strictEqual(await why(path.join(dir, 'missing-herdr')), 'not-installed');
  setState({ running: false });
  assert.strictEqual(await why(), 'not-running');
  fs.writeFileSync(sock, ''); // a socket file left behind by a crash
  assert.strictEqual(await why(), 'crashed');
  fs.rmSync(sock);
  setState({ running: true, protocol: 21, version: '0.8.0' });
  const inc = await diagnose(fake, sock, false, env);
  assert.deepStrictEqual([inc.reason, inc.version, inc.protocol], ['incompatible', '0.8.0', 21]);
  setState({ running: true, protocol: 22, compatible: false });
  assert.strictEqual(await why(), 'incompatible', 'herdr itself says incompatible');
  setState({ running: true, protocol: 22 });
  const unr = await diagnose(fake, sock, true, env, new Error('herdr session.snapshot timed out'));
  assert.deepStrictEqual([unr.reason, unr.detail, unr.customSocket], ['unreachable', 'herdr session.snapshot timed out', true]);
  setState({ statusBroken: true });
  assert.strictEqual(await why(), 'unreachable', "status that can't answer");
  assert.strictEqual(await serverStatus(fake, env), undefined);
  console.log('✓ diagnosis: not installed, not running, crashed, incompatible, unreachable');

  // starting the server
  const log = path.join(dir, 'logs', 'herdr-server.log');
  setState({ running: true, protocol: 22 });
  assert.deepStrictEqual(await startServer(fake, env, log), { ok: true, already: true });
  assert.ok(!fs.existsSync(startedFlag), 'never starts a second server for a running session');

  setState({ running: false, server: 'up' });
  assert.deepStrictEqual(await startServer(fake, env, log), { ok: true });
  assert.ok(fs.existsSync(startedFlag), 'started');
  killStarted();

  setState({ running: false, server: 'exit' });
  const ex = await startServer(fake, env, log);
  assert.ok(!ex.ok && /exited/.test(ex.error ?? ''), `early exit reported: ${ex.error}`);
  fs.rmSync(startedFlag, { force: true });

  setState({ running: false, server: 'hang' });
  const hang = await startServer(fake, env, log, 1500);
  assert.ok(!hang.ok && /didn't come up/.test(hang.error ?? ''), `timeout reported: ${hang.error}`);
  killStarted();

  assert.deepStrictEqual((await startServer(path.join(dir, 'missing-herdr'), env, log)).ok, false);

  // Only one window starts a session's server: a fresh lock held by another window means wait, not start.
  const lock = path.join(dir, 'locks', 'start.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  setState({ running: false, server: 'up' });
  const waited = await startServer(fake, env, log, 900, lock);
  assert.ok(!waited.ok && /another editor window is starting/.test(waited.error ?? ''), `waits for the other window: ${waited.error}`);
  assert.ok(!fs.existsSync(startedFlag), 'no second server started while another window holds the lock');
  setTimeout(() => setState({ running: true, protocol: 22 }), 400);
  assert.deepStrictEqual(await startServer(fake, env, log, 3000, lock), { ok: true, already: true }, "the other window's server came up");
  // A lock left by a start that died long ago is taken over, and released after
  setState({ running: false, server: 'up' });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.deepStrictEqual(await startServer(fake, env, log, 15_000, lock), { ok: true });
  assert.ok(fs.existsSync(startedFlag), 'started after taking over a stale lock');
  assert.ok(!fs.existsSync(lock), 'lock released');
  killStarted();

  // A custom socket must never start a second server for a session that already runs elsewhere.
  assert.strictEqual(sessionOfSocket('/Users/dev/.config/herdr/sessions/work/herdr.sock'), 'work');
  assert.strictEqual(sessionOfSocket('/tmp/custom.sock'), undefined);
  assert.strictEqual(herdrEnv('/Users/dev/.config/herdr/sessions/work/herdr.sock').HERDR_SESSION, 'work', 'named-session socket selects that session');
  setState({ running: false, defaultRunning: true, server: 'up' });
  const clash = await startServer(fake, herdrEnv('/tmp/custom.sock'), log);
  assert.ok(!clash.ok && /already running for this session/.test(clash.error ?? ''), `refuses: ${clash.error}`);
  assert.ok(!fs.existsSync(startedFlag), 'no second server started');
  console.log('✓ start server: already running (no second server), started, early exit, timeout, missing binary, one window at a time, custom-socket clash');

  // The server gets a terminal-like environment: no VS Code variables, and Kiro told not to wrap shells.
  const vs = serverEnv({ PATH: '/usr/bin', HOME: '/h', VSCODE_PID: '1', VSCODE_IPC_HOOK: '/x', ELECTRON_RUN_AS_NODE: '1', __CFBundleIdentifier: 'com.microsoft.VSCode', TERM_PROGRAM: 'vscode', HERDR_SESSION: 'w' });
  assert.deepStrictEqual(vs, { PATH: '/usr/bin', HOME: '/h', HERDR_SESSION: 'w', Q_TERM_DISABLED: '1' });
  assert.deepStrictEqual(serverEnv({ PATH: '/usr/bin', Q_TERM: '2.27.1', TERM_PROGRAM: 'ghostty' }), { PATH: '/usr/bin', Q_TERM: '2.27.1', TERM_PROGRAM: 'ghostty' }, 'inside a Kiro terminal: leave Kiro alone');
  console.log('✓ server environment: VS Code variables dropped, Kiro wrapper off');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nconnection tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
