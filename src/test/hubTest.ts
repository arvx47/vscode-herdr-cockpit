// Deep links, the hub files shared with the Herdr plugin, and tool lookup on macOS/Linux. No VS Code needed.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  claimant,
  editorCli,
  ensureHubWorkspace,
  hubWorkspaceFile,
  legacyHubWorkspaceFile,
  LINK_VERSION,
  isInsideRoots,
  parseLink,
  pruneClaims,
  readClaim,
  readEditorRecords,
  removeClaim,
  removeHubStatus,
  hubOpen,
  shouldOfferHub,
  takePendingLink,
  writeClaim,
  writeEditorRecord,
  writeHubStatus,
  writePendingLink,
  removeWindowRecord,
  WindowRecord,
  windowWithSpace,
  writeWindowRecord,
} from '../hubFiles';
import { findTool, toolDirs } from '../tools';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hub-'));

// ---------- links ----------
assert.deepStrictEqual(parseLink('/open', 'space=w1&pane=w1:p2&label=api&session=work&v=1'), { kind: 'open', space: 'w1', label: 'api', pane: 'w1:p2', session: 'work' });
assert.deepStrictEqual(parseLink('/review', 'space=w2'), { kind: 'review', space: 'w2', label: undefined, pane: undefined, session: undefined });
assert.deepStrictEqual(parseLink('/file', `path=${encodeURIComponent('/repo/src/a.ts')}&line=42&col=3`), { kind: 'file', path: '/repo/src/a.ts', line: 42, col: 3, session: undefined });
assert.deepStrictEqual(parseLink('/open', ''), { kind: 'open', space: undefined, label: undefined, pane: undefined, session: undefined }, 'just open the hub');
const rejects = (p: string, q: string, re: RegExp) => assert.throws(() => parseLink(p, q), re);
rejects('/open', 'pane=w1:p1;rm -rf', /invalid pane/);
rejects('/open', 'space=../../etc', /invalid space/);
rejects('/open', 'session=a/b', /invalid session/);
rejects('/file', 'path=relative/a.ts', /absolute/);
rejects('/file', `path=${encodeURIComponent('/a\0b')}`, /absolute/);
rejects('/file', 'path=/a.ts&line=-1', /invalid line/);
rejects('/file', `path=${encodeURIComponent('//host/share/x')}`, /local/);
rejects('/file', `path=${encodeURIComponent('\\\\host\\share\\x')}`, /local/);
rejects('/run', 'cmd=ls', /unknown link "run"/);
rejects('/open', `v=${LINK_VERSION + 1}`, /newer Herdr Cockpit/);
assert.strictEqual(parseLink('/file', `path=${encodeURIComponent('/repo/../etc/x')}`).kind === 'file' && (parseLink('/file', `path=${encodeURIComponent('/repo/../etc/x')}`) as any).path, '/etc/x', 'normalized');
console.log('✓ links parsed and validated (ids, session, absolute file paths, unknown actions, newer versions)');

// ---------- file links: inside a space or open folder, or ask ----------
{
  const space = path.join(home, 'space');
  fs.mkdirSync(path.join(space, 'src'), { recursive: true });
  fs.writeFileSync(path.join(space, 'src', 'a.ts'), '');
  fs.symlinkSync(path.join(home), path.join(space, 'escape'));
  assert.strictEqual(isInsideRoots(path.join(space, 'src', 'a.ts'), [space]), true);
  assert.strictEqual(isInsideRoots(path.join(home, 'secret'), [space]), false);
  assert.strictEqual(isInsideRoots(`${space}-other/x`, [space]), false, 'a sibling with the same prefix');
  assert.strictEqual(isInsideRoots(path.join(space, 'escape', 'secret'), [space]), false, 'a symlink out of the space');
  assert.strictEqual(isInsideRoots(path.join(space, '..', 'secret'), [space]), false);
  assert.strictEqual(isInsideRoots(path.join(space, 'src', 'new.ts'), [space]), true, 'a missing file inside the space');
  assert.strictEqual(isInsideRoots(path.join(fs.realpathSync(space), 'src', 'a.ts'), [space]), true, 'root given via a symlinked temp dir');
  console.log('✓ file links: inside a space, not a sibling, symlink or ../ out of it');
}

// ---------- hub workspace ----------
const ws = ensureHubWorkspace({ 'herdr.hubWindow': true }, home);
assert.strictEqual(ws, hubWorkspaceFile(home));
assert.deepStrictEqual(JSON.parse(fs.readFileSync(ws, 'utf8')).settings, { 'herdr.hubWindow': true });
fs.writeFileSync(ws, '{"folders":[],"settings":{"mine":1}}');
ensureHubWorkspace({ 'herdr.hubWindow': true }, home);
assert.strictEqual(JSON.parse(fs.readFileSync(ws, 'utf8')).settings.mine, 1, 'never overwrites an existing hub workspace');
assert.strictEqual(hubWorkspaceFile('/h'), '/h/.herdr-cockpit/herdr-cockpit.code-workspace');
assert.strictEqual(legacyHubWorkspaceFile('/h'), '/h/.herdr-hub/herdr-hub.code-workspace', 'the pre-rename hub workspace');
console.log('✓ hub workspace created once, never overwritten; pre-rename path kept');

// ---------- editor records + CLI lookup ----------
const mac = path.join(home, 'Cursor.app', 'Contents', 'Resources', 'app');
fs.mkdirSync(path.join(mac, 'bin'), { recursive: true });
fs.writeFileSync(path.join(mac, 'bin', 'code'), '');
assert.strictEqual(editorCli(mac, 'cursor'), path.join(mac, 'bin', 'code'), 'falls back to bin/code (Kiro, Positron)');
fs.writeFileSync(path.join(mac, 'bin', 'cursor'), '');
assert.strictEqual(editorCli(mac, 'cursor'), path.join(mac, 'bin', 'cursor'), 'prefers the product name');
const linux = path.join(home, 'usr', 'share', 'code');
fs.mkdirSync(path.join(linux, 'resources', 'app'), { recursive: true });
fs.mkdirSync(path.join(linux, 'bin'));
fs.writeFileSync(path.join(linux, 'bin', 'code'), '');
assert.strictEqual(editorCli(path.join(linux, 'resources', 'app'), 'code'), path.join(linux, 'bin', 'code'), 'Linux layout: <install>/bin');
assert.strictEqual(editorCli(path.join(home, 'nowhere'), 'code'), undefined);
assert.strictEqual(editorCli(mac, '../../evil'), path.join(mac, 'bin', 'code'), 'odd names ignored');

const rec = { name: 'Cursor', scheme: 'cursor', cli: '/x/cursor', extensionId: 'sriharirao.herdr-cockpit', extensionVersion: '1.0.0', linkVersion: 1, platform: 'darwin', updated: 1 };
writeEditorRecord(rec, home);
writeEditorRecord({ ...rec, scheme: '../evil' }, home);
assert.deepStrictEqual(readEditorRecords(home), [rec], 'one valid record; a bad scheme is never written');
console.log('✓ editor command line found (macOS and Linux layouts), editor records');

// ---------- hub status ----------
const st = { editor: 'Cursor', scheme: 'cursor', pid: 111, connected: true, state: 'connected', tabs: 2, agents: { working: 1, blocked: 0, done: 0, idle: 1 }, extensionVersion: '1', updated: 1 };
writeHubStatus(st, home);
const stFile = path.join(home, '.herdr-cockpit', 'status', 'cursor.json');
removeHubStatus('cursor', 222, home);
assert.ok(fs.existsSync(stFile), "another window's status is kept");
removeHubStatus('cursor', 111, home);
assert.ok(!fs.existsSync(stFile), 'own status removed');
writeHubStatus({ ...st, pid: process.pid, updated: Date.now() }, home);
assert.strictEqual(hubOpen('cursor', home), true, 'fresh status, live process');
assert.strictEqual(hubOpen('cursor', home, Date.now() + 120_000), false, 'stale heartbeat');
writeHubStatus({ ...st, pid: 999999, updated: Date.now() }, home);
assert.strictEqual(hubOpen('cursor', home), false, 'dead process');
assert.strictEqual(hubOpen('vscode', home), false, 'no status file');
const offer = (o: Partial<Parameters<typeof shouldOfferHub>[0]>) =>
  shouldOfferHub({ mode: 'emptyWindows', isHub: false, hasFolder: false, herdrInstalled: true, hubOpenElsewhere: false, ...o });
assert.deepStrictEqual(
  [offer({}), offer({ hasFolder: true }), offer({ hasFolder: true, mode: 'allWindows' }), offer({ mode: 'never' }), offer({ isHub: true }), offer({ herdrInstalled: false }), offer({ hubOpenElsewhere: true })],
  [true, false, true, false, false, false, false],
);
console.log('✓ hub status written and removed only by its owner');

// ---------- hand-off ----------
writePendingLink('cursor', '/open', 'space=w1', home);
assert.strictEqual(takePendingLink('vscode', 60_000, home), undefined, "another editor's link");
assert.deepStrictEqual(takePendingLink('cursor', 60_000, home), { path: '/open', query: 'space=w1' }, 'left for its own editor, then taken');
assert.strictEqual(takePendingLink('cursor', 60_000, home), undefined, 'taken once');
writePendingLink('cursor', '/open', 'space=w1', home);
assert.strictEqual(takePendingLink('cursor', -1, home), undefined, 'stale links are dropped');
console.log('✓ link hand-off: per editor, taken once, stale dropped');
writePendingLink('vscode', '/open', 'space=w2', home, '/repos/api/');
assert.strictEqual(takePendingLink('vscode', 60_000, home), undefined, "the Cockpit window leaves a link aimed at a space's window");
assert.strictEqual(takePendingLink('vscode', 60_000, home, (f) => f === '/repos/web'), undefined, 'a window with other folders leaves it too');
assert.deepStrictEqual(takePendingLink('vscode', 60_000, home, (f) => f === '/repos/api'), { path: '/open', query: 'space=w2' }, 'the window with that folder takes it (trailing slash ignored)');
console.log("✓ link hand-off: aimed at a space's own window by folder");

// ---------- windows ----------
const win = (pid: number, extra: Partial<WindowRecord> = {}): WindowRecord => ({ scheme: 'vscode', pid, socket: '/s', folders: [], spaces: [], updated: 1, ...extra });
writeWindowRecord(win(1, { folders: ['/repos/api'], spaces: ['api'], focus: '/repos/api' }), home);
writeWindowRecord(win(2, { folders: ['/home/.herdr-cockpit', '/repos/web/'], spaces: ['web', 'notes'], focus: '/home/.herdr-cockpit/herdr-cockpit.code-workspace' }), home);
writeWindowRecord(win(3, { folders: ['/repos/db'], spaces: ['db'], socket: '/other' }), home);
writeWindowRecord(win(4, { folders: ['/repos/old'], spaces: ['old'] }), home);
const alive = (pid: number) => pid !== 4;
const self = { scheme: 'vscode', pid: 1, socket: '/s' };
assert.strictEqual(windowWithSpace({ cwd: '/repos/web', label: 'x' }, self, home, alive)?.pid, 2, 'by folder');
assert.strictEqual(windowWithSpace({ cwd: '/repos/moved', label: 'notes' }, self, home, alive)?.pid, 2, 'by label when the folder moved');
assert.strictEqual(windowWithSpace({ cwd: '/repos/api', label: 'api' }, self, home, alive), undefined, 'not this window itself');
assert.strictEqual(windowWithSpace({ cwd: '/repos/db', label: 'db' }, self, home, alive), undefined, "another Herdr session's window");
assert.strictEqual(windowWithSpace({ cwd: '/repos/api', label: 'api' }, { ...self, scheme: 'cursor' }, home, alive), undefined, "another editor's window");
assert.strictEqual(windowWithSpace({ cwd: '/repos/old', label: 'old' }, self, home, alive), undefined, 'a window that quit');
assert.ok(!fs.existsSync(path.join(home, '.herdr-cockpit', 'windows', 'vscode-4.json')), "a window that quit loses its record");
removeWindowRecord('vscode', 2, home);
assert.strictEqual(windowWithSpace({ cwd: '/repos/web', label: 'web' }, self, home, alive), undefined, 'removed on close');
console.log('✓ windows: the one with a space, by folder or label, same editor and session, live only');

// ---------- pane claims ----------
const sock = '/run/herdr/a.sock';
const me = { scheme: 'vscode', pid: 100 };
const live = () => true;
writeClaim(sock, 'w1:p1', { editor: 'Kiro', scheme: 'kiro', pid: 200, at: 5000 }, home);
assert.deepStrictEqual(readClaim(sock, 'w1:p1', home), { editor: 'Kiro', scheme: 'kiro', pid: 200, at: 5000 });
assert.strictEqual(readClaim('/run/herdr/b.sock', 'w1:p1', home), undefined, 'per session: pane ids repeat across sessions');
assert.strictEqual(claimant(readClaim(sock, 'w1:p1', home), me, 4000, live), 'Kiro', 'took it after we did');
assert.strictEqual(claimant(readClaim(sock, 'w1:p1', home), me, 6000, live), undefined, 'a claim from before we took it: not who took it');
assert.strictEqual(claimant(readClaim(sock, 'w1:p1', home), me, 0, () => false), undefined, 'its window is gone');
assert.strictEqual(claimant({ editor: 'Visual Studio Code', scheme: 'vscode', pid: 300, at: 1 }, me, 0, live), 'another Visual Studio Code window');
assert.strictEqual(claimant({ editor: 'Visual Studio Code', scheme: 'vscode', pid: 100, at: 1 }, me, 0, live), undefined, 'our own claim');
assert.strictEqual(claimant(undefined, me, 0, live), undefined);
removeClaim(sock, 'w1:p1', 100, home);
assert.ok(readClaim(sock, 'w1:p1', home), "another window's claim is kept");
removeClaim(sock, 'w1:p1', 200, home);
assert.strictEqual(readClaim(sock, 'w1:p1', home), undefined, 'its own window removes it');
fs.mkdirSync(path.join(home, '.herdr-cockpit', 'claims'), { recursive: true });
writeClaim(sock, 'w1:p2', { editor: 'Kiro', scheme: 'kiro', pid: 200, at: 1 }, home);
const [cf] = fs.readdirSync(path.join(home, '.herdr-cockpit', 'claims'));
assert.match(cf, /^[0-9a-f]{24}\.json$/, 'file named by a hash: no pane id or socket path in it');
fs.writeFileSync(path.join(home, '.herdr-cockpit', 'claims', cf), '{"editor":1}');
assert.strictEqual(readClaim(sock, 'w1:p2', home), undefined, 'malformed claims are ignored');
writeClaim(sock, 'w1:p3', { editor: 'Kiro', scheme: 'kiro', pid: 201, at: 1 }, home);
writeClaim(sock, 'w1:p4', { editor: 'Cursor', scheme: 'cursor', pid: 202, at: 1 }, home);
pruneClaims(home, (pid) => pid === 202);
assert.deepStrictEqual([readClaim(sock, 'w1:p3', home), readClaim(sock, 'w1:p4', home)?.editor], [undefined, 'Cursor'], "gone windows' (and malformed) claims pruned");
assert.strictEqual(fs.readdirSync(path.join(home, '.herdr-cockpit', 'claims')).length, 1);
console.log('✓ pane claims: per session, who took it (newer than us, alive, not us), removed only by their owner');

// ---------- tools ----------
assert.strictEqual(toolDirs('/h', 'darwin')[0], '/opt/homebrew/bin');
assert.strictEqual(toolDirs('/h', 'linux')[0], '/h/.local/bin', "Herdr's installer default on Linux");
assert.ok(toolDirs('/h', 'linux').includes('/home/linuxbrew/.linuxbrew/bin'));
fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
fs.writeFileSync(path.join(home, '.local', 'bin', 'hb-fake-tool'), '');
assert.strictEqual(findTool('hb-fake-tool', [], home, 'linux'), path.join(home, '.local', 'bin', 'hb-fake-tool'));
assert.strictEqual(findTool('hb-missing-tool', [], home, 'linux'), 'hb-missing-tool', 'bare name: PATH lookup');
console.log('✓ tool lookup on macOS and Linux');

fs.rmSync(home, { recursive: true, force: true });
console.log('\nhub tests passed');
