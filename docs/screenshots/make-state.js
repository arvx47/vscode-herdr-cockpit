// Builds the data behind the README images from a running demo Herdr session (see README.md in this folder):
// the sidebar's real view state (buildViewState over the session's snapshot, git and pane activity), the Herdr
// TUI and one pane as HTML (captured terminal bytes rendered by xterm). Only the usage numbers are made up:
// demo agents have no plans.
//   node docs/screenshots/make-state.js [demo-root] [tui.raw] [cols] [rows]   (defaults: build/demo-root's folder, build/tui.raw)
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'build');
const lib = (m) => require(path.join(__dirname, '..', '..', 'out', m));
const { HerdrClient, resolveSocketPath } = lib('herdrClient');
const { normalize } = lib('model');
const { buildViewState, setAgentNames, shortPath } = lib('viewState');
const { ActivityWatcher } = lib('activity');
const { gitInfo } = lib('gitInfo');
const { HerdrStream } = lib('herdrStream');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const [demoRoot = fs.readFileSync(path.join(out, 'demo-root'), 'utf8').trim(), tuiRaw = path.join(out, 'tui.raw'), tuiCols = '104', tuiRows = '34'] = process.argv.slice(2);
const SESSION = 'hb-demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Demo paths read as ~/code/<repo> in the images, never the temporary folder. */
const scrub = (s) => s.split(fs.realpathSync(demoRoot)).join('~/code').split(demoRoot.replace(/\/$/, '')).join('~/code');

function toHtml(bytes, cols, rows) {
  return new Promise((resolve) => {
    const t = new Terminal({ cols, rows, allowProposedApi: true });
    const s = new SerializeAddon();
    t.loadAddon(s);
    t.write(bytes, () => resolve(s.serializeAsHTML({ includeGlobalBackground: true })));
  });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const client = new HerdrClient(() => resolveSocketPath(undefined, SESSION));
  const model = normalize(await client.request('session.snapshot'));

  // Real git status and pane activity, like the sidebar reads them.
  const git = (cwd) => gitInfo(cwd, () => {});
  for (const sp of model.spaces) git(sp.cwd);
  const activity = new ActivityWatcher(client);
  const targets = model.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).map((p) => ({ paneId: p.id, kind: p.isAgent ? 'agent' : 'shell', status: p.status }));
  await activity.poll(targets);
  await sleep(1500);
  await activity.poll(targets);

  const now = Date.now();
  const since = { claude: 2 * 60e3 + 14e3, codex: 40e3, kiro: 6 * 60e3 };
  const H = 3600e3;
  // Made-up plan usage (demo agents have no plans).
  const usage = [
    { id: 'claude', name: 'Claude Code', windows: [{ label: '5h', usedPercent: 42, resetsAt: now + 2.4 * H }, { label: '7d', usedPercent: 18, resetsAt: now + 71 * H }], asOf: now - 60e3, block: { tokens: 1_240_000, cacheRead: 8_100_000, startsAt: now - 2.6 * H, endsAt: now + 2.4 * H, exact: true } },
    { id: 'codex', name: 'Codex', plan: 'Plus', live: true, windows: [{ label: '5h', usedPercent: 63, resetsAt: now + 1.3 * H }, { label: '7d', usedPercent: 27, resetsAt: now + 98 * H }] },
    { id: 'kiro', name: 'Kiro', windows: [{ label: 'mo', usedPercent: 18, resetsAt: now + 23 * 24 * H }], credits: { today: 6.1, month: 182.4, limit: 1000 } },
  ];
  // Agents by kind ("Claude", "Codex"), never their terminal titles: those are the demo shells' prompts, with
  // this machine's user and host names in them.
  setAgentNames('herdr');
  const state = buildViewState({
    model,
    showShells: true,
    since: (id) => {
      const p = model.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).find((x) => x.id === id);
      return p?.agentKind && since[p.agentKind] ? now - since[p.agentKind] : undefined;
    },
    git,
    mounted: (sp) => sp.label === 'api-service',
    here: (sp) => sp.label === 'api-service',
    attached: (id) => id.startsWith('w1:'),
    activity: (id) => activity.get(id),
    usage,
    connection: { kind: 'connected', expectedProtocol: 22 },
  });
  // The cards' folder lines are shortened from the temporary path: shorten the ~/code one instead.
  for (const sp of state.spaces) {
    if (sp.folder && sp.path) {
      sp.folder.text = shortPath(scrub(sp.path));
    }
  }
  // "Other spaces" unfolded, so the images show every space.
  const ui = { open: {}, shellsOpen: {}, expanded: {}, othersOpen: true };
  fs.writeFileSync(path.join(out, 'state.js'), scrub(`window.DEMO_STATE = ${JSON.stringify(state, null, 1)};\nwindow.DEMO_UI = ${JSON.stringify(ui)};\n`));

  // The Herdr TUI, captured from a pty (tuicap.py).
  fs.writeFileSync(path.join(out, 'tui.html'), scrub(await toHtml(fs.readFileSync(tuiRaw), Number(tuiCols), Number(tuiRows))));

  // The Claude pane as a terminal tab shows it: one frame from Herdr's stream, at the tab's size.
  const pane = model.spaces[0].tabs[0].panes[0].id;
  const frames = [];
  const st = new HerdrStream('herdr', pane, { cols: 96, rows: 30 }, { ...process.env, HERDR_SESSION: SESSION }, { onFrame: (b) => frames.push(b), onClose: () => {} });
  await sleep(1500);
  st.release();
  fs.writeFileSync(path.join(out, 'pane.html'), scrub(await toHtml(Buffer.concat(frames), 96, 30)));
  // The same, as fragments the pages embed (the <pre> only; pages restyle font and background).
  const pre = (f) => /<pre>[\s\S]*<\/pre>/.exec(fs.readFileSync(path.join(out, f), 'utf8'))[0];
  fs.writeFileSync(path.join(out, 'fragments.js'), `window.DEMO_TUI = ${JSON.stringify(pre('tui.html'))};\nwindow.DEMO_PANE = ${JSON.stringify(pre('pane.html'))};\n`);
  console.log(`wrote ${out}: state.js (${state.spaces.length} spaces), tui.html, pane.html, fragments.js`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
