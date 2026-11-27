// Starts the demo Herdr session the README images show: a throwaway session named hb-demo (never your own; see
// CLAUDE.md) with three made-up repos in a temporary folder, Claude working, Codex blocked on a question and Kiro
// done. The agents are shell panes printing a canned screen, marked with pane.report_agent: nothing real runs.
//   node docs/screenshots/demo-session.js          prints the demo folder (pass it to make-state.js)
//   node docs/screenshots/demo-session.js stop     stops the server and deletes the folder
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const lib = (m) => require(path.join(__dirname, '..', '..', 'out', m));
const { HerdrClient, resolveSocketPath } = lib('drivers/herdr/herdrClient');
const { resolveBinary, serverStatus } = lib('drivers/herdr/connection');
const { terminalEnv } = lib('util/env');

const SESSION = 'hb-demo';
const herdr = resolveBinary();
const env = { ...process.env, HERDR_SESSION: SESSION };
const rootFile = path.join(__dirname, 'build', 'demo-root');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

const E = '\x1b[';
const [B, DIM, G, R, Y, C, O, N] = ['1m', '2m', '32m', '31m', '33m', '36m', '38;5;209m', '0m'].map((c) => E + c);
const SCREENS = {
  claude: [
    `${B}> Add rate limiting to the login route and cover it with tests${N}`,
    '',
    `${G}●${N} Read ${B}src/auth/middleware.ts${N}`,
    `${G}●${N} Wrote ${B}src/rate-limit.ts${N}            ${G}+24${N} ${R}−3${N}`,
    `${G}●${N} Updated ${B}src/auth/middleware.ts${N}      ${G}+6${N} ${R}−1${N}`,
    `${G}●${N} Ran ${C}npm test${N}`,
    `  ${DIM}⎿${N}  ${G}✓ 42 passed${N} · 0 failed`,
    '',
    `${O}✻ Wiring the limiter into the login route…${N} ${DIM}(2m 14s · esc to interrupt)${N}`,
  ],
  codex: [
    `${B}> Migrate the session store to Redis${N}`,
    '',
    `${G}•${N} Edited ${B}src/session/store.ts${N} (${G}+58${N} ${R}−21${N})`,
    `${G}•${N} Edited ${B}docker-compose.yml${N} (${G}+9${N} ${R}−0${N})`,
    '',
    `${Y}Allow command?${N}  ${C}docker compose up -d redis${N}`,
    `  ${B}▸ 1. Yes${N}`,
    '    2. No, and tell Codex what to do instead',
  ],
  kiro: [`${B}> Fix the broken links in the docs navigation${N}`, '', `${G}●${N} Checked 37 pages, fixed 4 links`, `${G}●${N} Build passed`, '', 'Done. Want me to open a pull request?'],
};

/** Three small repos with something to show in the git line: api-service has staged and new files. */
function makeRepos(root) {
  const repos = { 'api-service': 'feat/rate-limit', 'web-app': 'fix/docs-links', 'docs-site': 'main' };
  for (const [name, branch] of Object.entries(repos)) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
    git(dir, 'init', '-q', '-b', branch);
    git(dir, '-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', 'add', '-A');
    git(dir, '-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial commit');
  }
  const api = path.join(root, 'api-service');
  fs.mkdirSync(path.join(api, 'src', 'auth'));
  fs.writeFileSync(path.join(api, 'src', 'auth', 'middleware.ts'), 'export function requireAuth() {}\n');
  fs.writeFileSync(path.join(api, 'src', 'rate-limit.ts'), 'export const limits = {};\n');
  fs.writeFileSync(path.join(api, 'src', 'rate-limit.test.ts'), 'export {};\n');
  git(api, 'add', 'src/rate-limit.ts');
  fs.appendFileSync(path.join(root, 'web-app', 'README.md'), '\nSee the docs.\n');
  for (const [k, lines] of Object.entries(SCREENS)) fs.writeFileSync(path.join(root, `${k}.txt`), lines.join('\n') + '\n');
}

async function stop() {
  if ((await serverStatus(herdr, env))?.running) execFileSync(herdr, ['--session', SESSION, 'server', 'stop'], { env, stdio: 'ignore' });
  if (fs.existsSync(rootFile)) {
    fs.rmSync(fs.readFileSync(rootFile, 'utf8').trim(), { recursive: true, force: true });
    fs.rmSync(rootFile);
  }
  console.log(`stopped ${SESSION}`);
}

async function start() {
  if (process.env.HERDR_SOCKET_PATH) throw new Error('unset HERDR_SOCKET_PATH: it would point the demo at another server');
  if ((await serverStatus(herdr, env))?.running) throw new Error(`${SESSION} is already running (stop it with: node ${path.relative(process.cwd(), __filename)} stop)`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-demo-')));
  fs.mkdirSync(path.dirname(rootFile), { recursive: true });
  fs.writeFileSync(rootFile, root + '\n');
  makeRepos(root);

  const log = fs.openSync(path.join(root, 'server.log'), 'a');
  spawn(herdr, ['--session', SESSION, 'server'], { detached: true, stdio: ['ignore', log, log], env: terminalEnv(env) }).unref();
  for (let i = 0; i < 50 && !(await serverStatus(herdr, env))?.running; i++) await sleep(300);

  const c = new HerdrClient(() => resolveSocketPath(undefined, SESSION));
  const first = (await c.request('session.snapshot')).snapshot.workspaces.map((w) => w.workspace_id);
  const ws = {};
  for (const name of ['api-service', 'web-app', 'docs-site'])
    ws[name] = (await c.request('workspace.create', { cwd: path.join(root, name), label: name, focus: false })).workspace.workspace_id;
  for (const id of first) await c.request('workspace.close', { workspace_id: id }).catch(() => {});
  const snap = (await c.request('session.snapshot')).snapshot;
  const rootPane = (w) => snap.panes.find((p) => p.workspace_id === w).pane_id;
  const tab = async (w, label) => (await c.request('tab.create', { workspace_id: w, label, focus: false })).root_pane.pane_id;
  const panes = {
    claude: rootPane(ws['api-service']),
    codex: await tab(ws['api-service'], 'codex'),
    server: await tab(ws['api-service'], 'server'),
    kiro: rootPane(ws['web-app']),
  };
  await c.request('tab.rename', { tab_id: snap.panes.find((p) => p.pane_id === panes.claude).tab_id, label: 'claude' });
  await c.request('pane.rename', { pane_id: panes.server, label: 'dev server' });

  await sleep(1500); // shells start
  for (const k of ['claude', 'codex', 'kiro']) await c.request('pane.send_text', { pane_id: panes[k], text: `export PS1=''; clear; cat ${path.join(root, k + '.txt')}\n` });
  await c.request('pane.send_text', { pane_id: panes.server, text: `export PS1='%1~ ❯ '; clear; printf '  ➜  Local:   http://localhost:3000/\\n  ready in 412 ms\\n'\n` });
  await c.request('pane.send_text', { pane_id: rootPane(ws['docs-site']), text: `export PS1='%1~ ❯ '; clear\n` });
  await sleep(800);
  const report = (agent, state) => c.request('pane.report_agent', { pane_id: panes[agent], source: 'demo', agent, state });
  await report('claude', 'working');
  await report('codex', 'blocked');
  await report('kiro', 'working');
  await sleep(300);
  await report('kiro', 'idle'); // working → idle: Herdr shows it as done
  await c.request('workspace.focus', { workspace_id: ws['api-service'] });
  await c.request('pane.focus', { pane_id: panes.claude }).catch(() => {});
  console.log(root);
  process.exit(0);
}

(process.argv[2] === 'stop' ? stop() : start()).catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
