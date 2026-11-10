// Integration test in a real editor: `npm run test:vscode` (macOS or Linux, needs herdr and VS Code).
//
// Starts a separate editor instance (own user-data and extensions folders, a temporary HOME so its Cockpit window
// is ~/.herdr-cockpit of that HOME) with this extension loaded from source, against a throwaway Herdr session
// (`hb-vsc`), never the default one. The suite (suite.ts) runs inside that editor.
//   HERDR_HUB_TEST_EDITOR   editor executable (default: VS Code's in /Applications on macOS, `code` on Linux)
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { resolveBinary } from '../../connection';

const SESSION = 'hb-vsc';

// Run from a Herdr pane, the environment points at that (the user's) session: HERDR_SOCKET_PATH wins over
// HERDR_SESSION, so the test would create its spaces there and `server stop` would stop it (happened once).
for (const k of ['HERDR_SOCKET_PATH', 'HERDR_SESSION', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV']) delete process.env[k];

function herdr(bin: string, ...args: string[]): any {
  const out = execFileSync(bin, args, { env: { ...process.env, HERDR_SESSION: SESSION }, encoding: 'utf8' });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

async function main() {
  const bin = resolveBinary();
  const root = path.resolve(__dirname, '..', '..', '..');
  // Short paths: the editor's and Herdr's Unix sockets live under them (104-char limit on macOS).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbv.'));
  const home = path.join(tmp, 'h');
  const spaceDirs = ['s1', 's2'].map((d) => path.join(tmp, d));
  for (const d of [home, ...spaceDirs]) fs.mkdirSync(d, { recursive: true });

  // A throwaway Herdr session with two spaces.
  const status = () => {
    try {
      return JSON.parse(execFileSync(bin, ['status', 'server', '--json'], { env: { ...process.env, HERDR_SESSION: SESSION }, encoding: 'utf8' }));
    } catch {
      return {};
    }
  };
  let started = false;
  if (!status().running) {
    spawn(bin, ['server', '--session', SESSION], { env: { ...process.env, HERDR_SESSION: SESSION, Q_TERM_DISABLED: '1' }, detached: true, stdio: 'ignore' }).unref();
    started = true;
    for (let i = 0; i < 60 && !status().running; i++) await new Promise((r) => setTimeout(r, 250));
  }
  const socket = status().socket as string;
  if (!socket) throw new Error('could not start the hb-vsc Herdr session');
  if (!socket.includes(path.join('sessions', SESSION, ''))) throw new Error(`refusing to test against ${socket}: not the ${SESSION} session's socket`);
  const spaces = spaceDirs.map((cwd, i) => herdr(bin, 'workspace', 'create', '--cwd', cwd, '--label', `vsc-int-${i + 1}`).result.workspace.workspace_id as string);

  // The hub workspace and user settings of the test editor.
  fs.mkdirSync(path.join(home, '.herdr-cockpit'), { recursive: true });
  const hub = path.join(home, '.herdr-cockpit', 'herdr-cockpit.code-workspace');
  const platformKey = process.platform === 'darwin' ? 'osx' : 'linux';
  fs.writeFileSync(
    hub,
    // The suite switches spaces inside the Cockpit window: workspace mode. (In folder mode, the default since
    // herdr.windowMode, Switch to Space asks "its own window or this one?" and the suite would wait on it.)
    JSON.stringify({ folders: [{ path: '.', name: '· herdr cockpit' }], settings: { 'herdr.windowMode': 'workspace', [`terminal.integrated.defaultProfile.${platformKey}`]: 'Herdr Shell' } }, null, 2),
  );
  const userData = path.join(tmp, 'u');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'herdr.binaryPath': bin,
        'herdr.socketPath': socket,
        'herdr.startServer': 'never',
        'herdr.closeTabInHerdr': 'ask',
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'extensions.autoUpdate': false,
      },
      null,
      2,
    ),
  );

  const editor =
    process.env.HERDR_HUB_TEST_EDITOR ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
  let failed = false;
  try {
    await runTests({
      vscodeExecutablePath: editor,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite'),
      launchArgs: [hub, '--user-data-dir', userData, '--extensions-dir', path.join(tmp, 'x'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: {
        HOME: home,
        HERDR_HUB_TEST_SESSION: SESSION,
        HERDR_HUB_TEST_SPACES: spaces.join(','),
        HERDR_BIN: bin,
        HERDR_HUB_TEST_REAL_HOME: os.homedir(),
      },
    });
  } catch (e) {
    failed = true;
    console.error(e);
  } finally {
    for (const id of spaces) {
      try {
        herdr(bin, 'workspace', 'close', id);
      } catch {
        // already closed by the test
      }
    }
    if (started) execFileSync(bin, ['server', 'stop'], { env: { ...process.env, HERDR_SESSION: SESSION } });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
