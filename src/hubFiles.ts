// Files under ~/.herdr-cockpit that the extension shares with the Herdr plugin (plugin/), and the deep links the
// plugin opens. No vscode imports. (Before the rename to Herdr Cockpit, from Herdr Hub, this was ~/.herdr-hub: its
// workspace is still recognized as the Cockpit window, see legacyHubWorkspaceFile.)
//
//   herdr-cockpit.code-workspace   the Cockpit window's workspace (folder slot 0 = ~/.herdr-cockpit)
//   editors/<scheme>.json      one per editor the extension has run in: how the plugin finds its command line
//   status/<scheme>.json       the Cockpit window's live state, for the plugin's status pane
//   pending-link.json          a link that reached another window, handed to the Cockpit window
//   claims/<hash>.json         which editor window last took control of a pane (Herdr doesn't say who has it)
//   windows/<scheme>-<pid>.json   each window's folders and the spaces it has open, so a click elsewhere goes there
//
// Links: <scheme>://<publisher>.herdr-cockpit/<action>?<query>, where <scheme> is the editor's (vscode, cursor,
// kiro, positron, ...). Every field is validated here: a link can come from any web page, so it may only
// pick things the user already has (a space, a pane, a file), never a program or a setting. A file outside
// the user's spaces and open folders needs a confirmation (isInsideRoots); network paths are refused.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXTENSION_NAME } from './brand';

/** Bump when the link format changes incompatibly; the plugin compares it with what it speaks. */
export const LINK_VERSION = 1;

export const hubDir = (home = os.homedir()) => path.join(home, '.herdr-cockpit');
export const hubWorkspaceFile = (home?: string) => path.join(hubDir(home), 'herdr-cockpit.code-workspace');
/** The hub workspace from before the rename (Herdr Hub): a window restored with it is still the Cockpit window. */
/** The name before the rename to Herdr Cockpit, for the legacy paths below. */
export const LEGACY_NAME = ['herdr', 'hub'].join('-');
export const legacyHubWorkspaceFile = (home = os.homedir()) => path.join(home, `.${LEGACY_NAME}`, `${LEGACY_NAME}.code-workspace`);

/** Create ~/.herdr-cockpit and its workspace file if missing (never overwrites). Returns the workspace file. */
export function ensureHubWorkspace(settings: Record<string, unknown>, home?: string): string {
  const dir = hubDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme))
    fs.writeFileSync(
      readme,
      '# ' + EXTENSION_NAME + '\n\nThis folder stays as the first workspace folder so the editor never restarts extensions when you switch Herdr spaces.\nSpaces are mounted below it as `⬢ <name>` folders.\n',
    );
  const file = hubWorkspaceFile(home);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ folders: [{ path: '.', name: '· herdr cockpit' }], settings }, null, 2));
  return file;
}

/** Write via a temp file and rename, so a reader never sees half a file. */
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

// ---------- editors ----------

export interface EditorRecord {
  /** Display name, e.g. "Visual Studio Code", "Cursor". */
  name: string;
  /** URL scheme, e.g. "vscode", "cursor". */
  scheme: string;
  /** The editor's command-line launcher, when found. */
  cli?: string;
  extensionId: string;
  extensionVersion: string;
  linkVersion: number;
  platform: string;
  /** ms since epoch. */
  updated: number;
}

/**
 * The editor's command-line launcher inside its install. macOS: <app>/Contents/Resources/app/bin; Linux:
 * <install>/bin next to resources/app. Named after the product (code, cursor), or `code` in forks that
 * only ship that name (Kiro, Positron).
 */
export function editorCli(appRoot: string, applicationName?: string): string | undefined {
  const names = [...new Set([applicationName, 'code'].filter((n): n is string => !!n && /^[\w.-]+$/.test(n)))];
  const dirs = [path.join(appRoot, 'bin'), path.resolve(appRoot, '..', '..', 'bin')];
  for (const d of dirs) for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
}

export function writeEditorRecord(rec: EditorRecord, home?: string) {
  if (!SCHEME.test(rec.scheme)) return;
  writeJson(path.join(hubDir(home), 'editors', `${rec.scheme}.json`), rec);
}

export function readEditorRecords(home?: string): EditorRecord[] {
  const dir = path.join(hubDir(home), 'editors');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJson(path.join(dir, n))).filter((r): r is EditorRecord => typeof r?.scheme === 'string' && SCHEME.test(r.scheme));
}

// ---------- hub status ----------

export interface HubStatus {
  editor: string;
  scheme: string;
  /** Extension host process; the plugin treats a dead pid as "not running". */
  pid: number;
  connected: boolean;
  /** Why not connected (connection.ts DownReason, or reconnecting/connecting/starting). */
  state: string;
  /** Herdr session name; undefined = default session. */
  session?: string;
  /** The space whose tabs are open, by label. */
  space?: string;
  /** Live attach tabs. */
  tabs: number;
  agents: { working: number; blocked: number; done: number; idle: number };
  extensionVersion: string;
  updated: number;
}

const statusFile = (scheme: string, home?: string) => path.join(hubDir(home), 'status', `${scheme}.json`);

export function writeHubStatus(s: HubStatus, home?: string) {
  if (SCHEME.test(s.scheme)) writeJson(statusFile(s.scheme, home), s);
}

/**
 * A Cockpit window of this editor is open right now: its status file is fresh (heartbeat every 30s) and its
 * extension host is alive.
 */
export function hubOpen(scheme: string, home?: string, now = Date.now()): boolean {
  if (!SCHEME.test(scheme)) return false;
  const s = readJson(statusFile(scheme, home));
  if (typeof s?.pid !== 'number' || typeof s?.updated !== 'number' || now - s.updated > 90_000) return false;
  return alive(s.pid);
}

export type OfferHubSetting = 'emptyWindows' | 'allWindows' | 'never';

/** Whether to ask "Open Herdr Cockpit here?" when a window opens (herdr.offerHubOnStartup). */
export function shouldOfferHub(w: { mode: OfferHubSetting; isHub: boolean; hasFolder: boolean; herdrInstalled: boolean; hubOpenElsewhere: boolean }): boolean {
  if (w.mode === 'never' || w.isHub || !w.herdrInstalled || w.hubOpenElsewhere) return false;
  return w.mode === 'allWindows' || !w.hasFolder;
}

/** Remove this process's status file (a newer Cockpit window of the same editor may have replaced it: keep that). */
export function removeHubStatus(scheme: string, pid: number, home?: string) {
  if (!SCHEME.test(scheme)) return;
  const f = statusFile(scheme, home);
  if (readJson(f)?.pid === pid) fs.rmSync(f, { force: true });
}

// ---------- pane claims ----------
// Herdr lets one client control a pane and tells the one it replaces only "taken over". So each window
// records the panes it takes control of, and the window that lost one can say who has it now ("Kiro").

export interface PaneClaim {
  /** Editor display name, e.g. "Kiro". */
  editor: string;
  scheme: string;
  /** Extension host process of the window that took the pane. */
  pid: number;
  /** ms since epoch. */
  at: number;
  /**
   * The window, kept across reloads (windowKey()). A reload starts a new extension host while the old one is still
   * exiting, so its pid looks alive for a few seconds: this says the claim is ours from before the reload.
   */
  window?: string;
}

/** A short stable id for a window, from something that survives reloads (its workspace storage folder). */
export const windowKey = (id: string) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);

/** One file per pane of a Herdr session (its socket): pane ids repeat across sessions. */
const claimFile = (socket: string, pane: string, home?: string) =>
  path.join(hubDir(home), 'claims', crypto.createHash('sha256').update(`${socket}\n${pane}`).digest('hex').slice(0, 24) + '.json');

/**
 * A process with this pid is running. Only real pids (> 1): kill(0) signals our own process group and kill(-1)
 * every process we may signal, so a file saying pid 0 or -1 would otherwise always look alive.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM'; // alive, owned by someone else
  }
}

const errnoCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

export function writeClaim(socket: string, pane: string, claim: PaneClaim, home?: string) {
  try {
    writeJson(claimFile(socket, pane, home), claim);
  } catch {
    // best effort: without it the other window just can't name us
  }
}

export function readClaim(socket: string, pane: string, home?: string): PaneClaim | undefined {
  const c = readJson(claimFile(socket, pane, home));
  if (typeof c?.editor !== 'string' || typeof c?.scheme !== 'string' || typeof c?.pid !== 'number' || typeof c?.at !== 'number') return undefined;
  const claim: PaneClaim = { editor: c.editor.slice(0, 80), scheme: c.scheme, pid: c.pid, at: c.at };
  if (typeof c.window === 'string') {
    claim.window = c.window.slice(0, 64);
  }
  return claim;
}

/** Drop this window's claim (it released the pane, or lost it); another window's newer claim stays. */
export function removeClaim(socket: string, pane: string, pid: number, home?: string) {
  const f = claimFile(socket, pane, home);
  if (readJson(f)?.pid === pid) fs.rmSync(f, { force: true });
}

/** Remove claims whose window is gone (they'd only pile up: windows that quit can't remove their own). */
export function pruneClaims(home?: string, isAlive = alive) {
  const dir = path.join(hubDir(home), 'claims');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const n of names) {
    const c = readJson(path.join(dir, n));
    if (typeof c?.pid !== 'number' || !isAlive(c.pid)) fs.rmSync(path.join(dir, n), { force: true });
  }
}

/** How long a notification claim is kept: long enough for every window to have seen the same change. */
const NOTIFIED_TTL_MS = 10 * 60_000;

/**
 * Every window of every editor gets the same agent status change, so each would show the same notification.
 * The first window to claim a change shows it: true means this one. `change` names it (socket, pane, status
 * and Herdr's state_change_seq), so the next change of the same pane is a new claim.
 */
export function claimNotification(change: string, home?: string, now = Date.now()): boolean {
  const dir = path.join(hubDir(home), 'notified');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      try {
        if (now - fs.statSync(f).mtimeMs > NOTIFIED_TTL_MS) {
          fs.rmSync(f, { force: true });
        }
      } catch {
        // removed by another window meanwhile
      }
    }
  } catch {
    return true; // can't share the folder: better twice than never
  }
  const file = path.join(dir, crypto.createHash('sha256').update(change).digest('hex').slice(0, 24));
  try {
    // 'wx' fails when the file exists: exactly one window creates it.
    fs.closeSync(fs.openSync(file, 'wx'));
    return true;
  } catch (e) {
    return errnoCode(e) !== 'EEXIST';
  }
}

/**
 * Who has the pane, from this window's point of view: another live window's claim. `since` = when this window
 * took the pane: a claim older than that is from before (that window lost the pane to us since).
 */
export function claimant(c: PaneClaim | undefined, me: { scheme: string; pid: number; window?: string }, since = 0, isAlive = alive): string | undefined {
  if (!c || c.pid === me.pid || c.at < since || !isAlive(c.pid)) return undefined;
  if (c.window && c.window === me.window) {
    return undefined; // this window, before it reloaded
  }
  return c.scheme === me.scheme ? `another ${c.editor} window` : c.editor;
}

// ---------- windows ----------
// Each window records its folders and the spaces it has open. A click on a space that another window already
// has goes to that window instead of swapping this window's folders.

export interface WindowRecord {
  scheme: string;
  /** Extension host process: one per window. */
  pid: number;
  /** The Herdr socket it talks to: another session's spaces don't count. */
  socket: string;
  /** Its folders, absolute. */
  folders: string[];
  /** Labels of the spaces it has open (a space's folder can move with its shell's cwd; the label doesn't). */
  spaces: string[];
  /** What to open to bring the window forward: its workspace file, or its only folder. None for an untitled workspace. */
  focus?: string;
  updated: number;
}

export const normPath = (p: string) => path.resolve(p).replace(/(.)\/+$/, '$1');
const windowFile = (scheme: string, pid: number, home?: string) => path.join(hubDir(home), 'windows', `${scheme}-${pid}.json`);

export function writeWindowRecord(w: WindowRecord, home?: string) {
  writeJson(windowFile(w.scheme, w.pid, home), w);
}

export function removeWindowRecord(scheme: string, pid: number, home?: string) {
  fs.rmSync(windowFile(scheme, pid, home), { force: true });
}

/** Live windows' records; those of windows that quit are removed. */
function readWindowRecords(home?: string, isAlive = alive): WindowRecord[] {
  const dir = path.join(hubDir(home), 'windows');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: WindowRecord[] = [];
  for (const n of names) {
    const w = readJson(path.join(dir, n));
    const valid =
      typeof w?.scheme === 'string' && typeof w?.pid === 'number' && typeof w?.socket === 'string' && Array.isArray(w?.folders) && Array.isArray(w?.spaces);
    if (!valid || !isAlive(w.pid)) {
      fs.rmSync(path.join(dir, n), { force: true });
      continue;
    }
    out.push({
      scheme: w.scheme,
      pid: w.pid,
      socket: w.socket,
      folders: w.folders.filter((f: unknown): f is string => typeof f === 'string').map(normPath),
      spaces: w.spaces.filter((s: unknown): s is string => typeof s === 'string'),
      focus: typeof w.focus === 'string' ? w.focus : undefined,
      updated: typeof w.updated === 'number' ? w.updated : 0,
    });
  }
  return out;
}

/** Another live window of this editor and Herdr session that has the space open: by its folder, else by its label. */
export function windowWithSpace(
  space: { cwd?: string; label: string },
  me: { scheme: string; pid: number; socket: string },
  home?: string,
  isAlive = alive,
): WindowRecord | undefined {
  const others = readWindowRecords(home, isAlive).filter((w) => w.scheme === me.scheme && w.pid !== me.pid && w.socket === me.socket);
  const cwd = space.cwd ? normPath(space.cwd) : undefined;
  return others.find((w) => !!cwd && w.folders.includes(cwd)) ?? others.find((w) => w.spaces.includes(space.label));
}

// ---------- workspaces for windows with several spaces ----------
// Adding a folder to a window without a workspace file makes it an untitled workspace, which no other window can
// open or bring forward. So a window that takes a second space is reopened on a workspace file of its own instead.

/**
 * The workspace file for these folders: ~/.herdr-cockpit/workspaces/<folder names>-<id>.code-workspace, the id
 * from the folder paths, so the same folders always get the same file. An existing file is reused untouched (you
 * may have changed its settings); a new one gets the folders and `settings`.
 */
export function spacesWorkspaceFile(folders: { path: string; name?: string }[], settings: Record<string, unknown> = {}, home?: string): string {
  const paths = folders.map((f) => normPath(f.path));
  const id = crypto.createHash('sha256').update(paths.join('\n')).digest('hex').slice(0, 8);
  const names = paths
    .map((p) => path.basename(p) || 'root')
    .join('+')
    .replace(/[^A-Za-z0-9._+-]/g, '_')
    .slice(0, 80);
  const file = path.join(hubDir(home), 'workspaces', `${names}-${id}.code-workspace`);
  if (!fs.existsSync(file)) {
    writeJson(file, { folders: folders.map((f, i) => ({ path: paths[i], ...(f.name && { name: f.name }) })), settings });
  }
  return file;
}

// ---------- links ----------

export type LinkRequest =
  | { kind: 'open'; space?: string; label?: string; pane?: string; session?: string }
  | { kind: 'review'; space?: string; label?: string; pane?: string; session?: string }
  | { kind: 'file'; path: string; line?: number; col?: number; session?: string };

const ID = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION = /^[A-Za-z0-9._-]{1,64}$/;

/** Parse and validate a link's path and query. Throws with a user-facing reason. */
export function parseLink(linkPath: string, query: string): LinkRequest {
  const action = linkPath.replace(/^\/+|\/+$/g, '');
  const q = new URLSearchParams(query);
  const v = Number(q.get('v') ?? LINK_VERSION);
  if (v > LINK_VERSION) throw new Error(`the link needs a newer ${EXTENSION_NAME} (link version ${v}, this one understands ${LINK_VERSION})`);
  const id = (k: string) => {
    const x = q.get(k);
    if (x === null || x === '') return undefined;
    if (!ID.test(x)) throw new Error(`invalid ${k}`);
    return x;
  };
  const label = q.get('label')?.slice(0, 200) || undefined;
  const sessionRaw = q.get('session') || undefined;
  if (sessionRaw && !SESSION.test(sessionRaw)) throw new Error('invalid session');
  const session = sessionRaw;
  const num = (k: string) => {
    const x = q.get(k);
    if (!x) return undefined;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new Error(`invalid ${k}`);
    return n;
  };
  switch (action) {
    case 'open':
    case 'review':
      return { kind: action, space: id('space'), label, pane: id('pane'), session };
    case 'file': {
      const p = q.get('path');
      // No network paths (\\host\share, //host/share): opening one can send credentials to that host.
      if (!p || !path.isAbsolute(p) || p.includes('\0') || /^[\\/]{2}/.test(p)) throw new Error('the file path must be absolute and local');
      return { kind: 'file', path: path.normalize(p), line: num('line'), col: num('col'), session };
    }
    default:
      throw new Error(`unknown link "${action || '(none)'}"`);
  }
}

/**
 * The file is inside one of `roots` (symlinks resolved), e.g. a Herdr space's folder. A `file` link to
 * anything else asks first: a web page could otherwise put ~/.ssh or .env files on screen.
 */
export function isInsideRoots(file: string, roots: readonly string[]): boolean {
  // Resolve symlinks in the deepest part of the path that exists (the file itself may not): a missing file
  // under a symlinked folder must still resolve to where that folder really is.
  const real = (p: string): string => {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch {
      const parent = path.dirname(abs);
      return parent === abs ? abs : path.join(real(parent), path.basename(abs));
    }
  };
  const f = real(file);
  return roots.some((r) => {
    const root = real(r);
    return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

// ---------- hand-off to the Cockpit window ----------

const pendingFile = (home?: string) => path.join(hubDir(home), 'pending-link.json');

/** `folder`: only the window that has this folder takes it (a space's own window); none = the Cockpit window. */
export function writePendingLink(scheme: string, linkPath: string, query: string, home?: string, folder?: string) {
  writeJson(pendingFile(home), { scheme, path: linkPath, query, created: Date.now(), ...(folder && { folder: normPath(folder) }) });
}

/**
 * Take the pending link for this editor, if fresh and meant for this window (`mine` gets the link's target
 * folder, undefined for the Cockpit window). Taking renames the file first, so two windows can't both act on it.
 */
export function takePendingLink(
  scheme: string,
  maxAgeMs = 60_000,
  home?: string,
  mine: (folder: string | undefined) => boolean = (folder) => !folder,
): { path: string; query: string } | undefined {
  const f = pendingFile(home);
  const peek = readJson(f);
  if (peek?.scheme !== scheme) return undefined; // another editor's: leave it
  if (!mine(typeof peek.folder === 'string' ? peek.folder : undefined)) return undefined; // another window's
  const taken = `${f}.${process.pid}.taken`;
  try {
    fs.renameSync(f, taken);
  } catch {
    return undefined;
  }
  const p = readJson(taken);
  // A newer link may have replaced the one peeked at before the rename: check again what was taken, and give
  // another window's (or editor's) link back.
  if (p?.scheme !== scheme || !mine(typeof p.folder === 'string' ? p.folder : undefined)) {
    putBack(taken, f);
    return undefined;
  }
  fs.rmSync(taken, { force: true });
  if (typeof p.path !== 'string' || typeof p.query !== 'string') return undefined;
  if (!(Date.now() - p.created < maxAgeMs)) return undefined;
  return { path: p.path, query: p.query };
}

/** Puts a taken link back, unless an even newer one was written meanwhile (then the taken one is stale). */
function putBack(taken: string, f: string) {
  try {
    fs.linkSync(taken, f); // fails if `f` exists: never overwrites a newer link
  } catch {
    // a newer link is there, or the folder is gone
  }
  fs.rmSync(taken, { force: true });
}
