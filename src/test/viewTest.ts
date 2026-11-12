// Pure tests for shell/agent summaries and the sidebar view state. Inputs are real outputs
// captured from herdr 0.9.1 panes. No VS Code or socket needed.
import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { describeProcess, isShellProcess, summarizeAgent, summarizeShell } from '../activity';
import * as vm from 'vm';
import { allPanes, attachOrder, countByStatus, findPane, needingAttention, normalize, repoSpace } from '../model';
import type { Space } from '../model';
import { ago, left } from '../format';
import { buildViewState, folderLine, headline, orderByActivity, paneName, setAgentNames, shortPath, spacesLayout, todayLines, usageView } from '../viewState';
import type { PaneActivity } from '../activity';
import type { PaneProcessInfo, SessionSnapshotResult } from '../herdrTypes';

const zsh: PaneProcessInfo = { pane_id: 'w2:p5', foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: 'zsh', argv: ['-zsh'] }] };
const P = 'dev@laptop api-service %';

// ---- processes
assert.strictEqual(
  describeProcess({ pid: 1, name: 'Python', argv: ['/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python', 'app.py'] }),
  'python app.py',
);
assert.strictEqual(describeProcess({ pid: 1, name: 'vim', argv: ['vi', '/Users/dev/code/api-service/config.yaml'] }), 'vi config.yaml');
assert.strictEqual(describeProcess({ pid: 1, name: 'node', argv: ['/opt/homebrew/bin/npm', 'run', 'dev'] }), 'npm run dev');
assert.strictEqual(describeProcess({ pid: 1, name: 'python3', argv: ['python3', '-m', 'http.server', '8000'] }), 'python3 -m http.server');
assert.ok(isShellProcess('zsh (kiro-cli-term)') && isShellProcess('zsh (kiro-cli-t') && isShellProcess('-zsh') && !isShellProcess('python'), 'wrapped shells are shells, even with the name truncated');
console.log('✓ describeProcess');

// ---- shell at prompt: last command, its output, failure detection
let s = summarizeShell(zsh, ['AUTOSSH_GATETIME=0 autossh -M 0 -f -N -i /Users/dev/.ssh/tunnel.pem \\', 'Connection to localhost port 5433 [tcp/*] succeeded!', 'tunnel up', P].map((l, i) => (i === 0 ? `${P} ${l}` : l)).join('\n'));
assert.deepStrictEqual(s, { state: 'prompt', command: 'autossh -M 0 -f -N -i tunnel.pem', typed: undefined, output: ['Connection to localhost port 5433 [tcp/*] succeeded!', 'tunnel up'], failed: false });
s = summarizeShell(zsh, [`${P} ssh -i /k/key.pem host`, 'ssh: connect to host 192.0.2.10 port 22: Connection refused', `${P} ssh -i /k/key.pem host`].join('\n'));
assert.strictEqual(s.command, 'ssh -i key.pem host');
assert.strictEqual(s.typed, undefined, 'recalled history equal to last command is not "typed"');
assert.strictEqual(s.failed, true);
s = summarizeShell(zsh, [`${P} ls`, 'a b', `${P} git push`].join('\n'));
assert.strictEqual(s.typed, 'git push');
s = summarizeShell(zsh, ['Restored session: Fri Oct  2', `${P} cd ~/Desktop`, P, ''].join('\n'));
assert.deepStrictEqual([s.command, s.output], ['cd ~/Desktop', []]);
// venv-prefixed prompts and activation commands typed by an editor extension (real herdr output)
const V = '(api-service) dev@laptop api-service %';
s = summarizeShell(zsh, [`${P} autossh -M 0 -f -N jumphost`, 'tunnel up', 'agent/.venv/bin/activate',
  `${V}  source /Users/dev/code/api-service/`, `${V}  source /Users/dev/code/api-service/`, V].join('\n'));
assert.deepStrictEqual([s.command, s.typed, s.output], ['autossh -M 0 -f -N jumphost', undefined, ['tunnel up']], 'activation noise skipped');
s = summarizeShell(zsh, ['stopped job 7', `${P}  source /Users/dev/code/api-service/.venv/bin/acti(api-service`].join('\n'));
assert.deepStrictEqual([s.typed, s.output], [undefined, ['stopped job 7']], 'half-typed activation is not "typed"');
s = summarizeShell(zsh, [`${V} npm run dev`, 'ready on :3000', V].join('\n'));
assert.deepStrictEqual([s.command, s.output], ['npm run dev', ['ready on :3000']], 'venv prompt recognized');
// running a full-screen program: no screen preview
s = summarizeShell({ pane_id: 'x', foreground_process_group_id: 7, foreground_processes: [{ pid: 7, name: 'vim', argv: ['vi', 'a.yaml'] }] }, '      - "mysql * -e *DROP*"');
assert.deepStrictEqual([s.state, s.command, s.output], ['running', 'vi a.yaml', []]);
console.log('✓ summarizeShell');

// ---- agent screens: drop the input box / footer unless blocked
const claudeDone = ['  Sources:', '  - API reference overview', '', '✻ Crunched for 1m 59s · done Saturday 5:02 PM', '   ', '────────', '❯', '────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent', ''].join('\n');
assert.deepStrictEqual(summarizeAgent(claudeDone, 'idle'), ['Sources:', '- API reference overview', '✻ Crunched for 1m 59s · done Saturday 5:02 PM']);
const survey = ['Done, tests pass.', '', '● How is Claude doing this session? (optional)', '  1: Bad    2: Fine   3: Good   0: Dismiss', '────', '❯', '────'].join('\n');
assert.deepStrictEqual(summarizeAgent(survey, 'idle'), ['Done, tests pass.'], 'feedback survey dropped');
const blocked = ['╭──────────╮', '│ Bash command │', '│ Do you want to proceed? │', '│ ❯ 1. Yes │', '│   2. No │', '╰──────────╯'].join('\n');
assert.deepStrictEqual(summarizeAgent(blocked, 'blocked'), ['Bash command', 'Do you want to proceed?', '❯ 1. Yes', '2. No']);
assert.strictEqual(headline(['x', '※ recap: You are making the app', 'consistent. Next, review it.', 'new task? /clear']), 'You are making the app consistent. Next, review it. new task? /clear');
assert.strictEqual(headline(['One note: your API token expires soon. If', 'you ever hit an error, re-auth.']), 'One note: your API token expires soon. If you ever hit an error, re-auth.');
assert.strictEqual(headline(['Otherwise run it in a separate terminal window.', '✻ Churned for 5s · done 12:18 PM']), 'Otherwise run it in a separate terminal window.', 'timing line skipped');
assert.strictEqual(headline(['✻ Baked for 35s · done 10:30 AM']), '✻ Baked for 35s · done 10:30 AM', 'only a timing line: keep it');
console.log('✓ summarizeAgent / headline');

// ---- view state from the real snapshot
const fixture: { result: SessionSnapshotResult } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'snapshot-herdr-0.9.1.json'), 'utf8'),
);
const model = normalize(fixture.result);
const acts: Record<string, PaneActivity> = {
  'w5:p3': { state: 'running', command: 'python app.py', output: ['GET / 200'], failed: false },
  'w2:pA': { state: 'prompt', command: 'cd ~', output: [], failed: false },
  'w4:p1': { output: ['To be clear about how I operate', 'What would you like to do next?'], failed: false },
};
const vs = buildViewState({
  model, showShells: true,
  since: () => undefined, git: () => undefined, mounted: (sp) => sp.id === 'w6', attached: () => false,
  activity: (id) => acts[id],
  usage: ['claude', 'codex', 'kiro', 'gemini'].map((id) => ({ id, name: id, windows: [] })),
  connection: { kind: 'connected', expectedProtocol: 22 },
});
const sp = (id: string) => vs.spaces.find((x) => x.id === id)!;
assert.strictEqual(vs.totals.agents, 5);
assert.strictEqual(vs.totals.shells, 10);
assert.deepStrictEqual(sp('w2').shells.map((x) => x.name), ['DB Tunnel', 'Git Review', 'reviewr', 'Cloud Login', 'Tab 5', 'Tab 6']);
assert.strictEqual(sp('w2').shells.find((x) => x.id === 'w2:p8')!.tab, 'Git Review', 'tab chip when it differs from the name');
assert.strictEqual(sp('w5').shells.find((x) => x.id === 'w5:p3')!.name, 'Tab 3', 'numbered tab, even while running (tab names must stay stable)');
const kiro = sp('w4').agents[0];
assert.deepStrictEqual([kiro.name, kiro.detail, kiro.headline], ['Kiro', undefined, 'What would you like to do next?'], 'kiro: ~/path title is dropped');
assert.deepStrictEqual([sp('w2').agents[0].name, sp('w2').agents[0].detail], ['Add pagination to the orders API', undefined], 'session title is the name, not repeated as detail');
assert.strictEqual(sp('w6').mounted, true);
assert.strictEqual(sp('w8').agents.length, 0);
assert.deepStrictEqual(vs.attention, []);
assert.deepStrictEqual(vs.usage.map((u) => u.id), ['claude', 'kiro'], 'usage only for agents running in Herdr (fixture: claude, kiro)');
const hidden = buildViewState({ model, showShells: false, since: () => undefined, git: () => undefined, mounted: () => false, attached: () => false, activity: () => undefined, usage: [], connection: { kind: 'connected', expectedProtocol: 22 } });
assert.ok(hidden.spaces.every((x) => x.shells.length === 0));
console.log('✓ view state from real snapshot');

// ---- space filter: only this window's spaces are listed; counters, Needs you and labels still cover all
const inputs = {
  model, showShells: true,
  since: () => undefined, git: () => undefined, mounted: () => false, attached: () => false,
  activity: (id: string) => acts[id],
  usage: [],
  connection: { kind: 'connected' as const, expectedProtocol: 22 },
};
const all = buildViewState(inputs);
const mine = buildViewState({ ...inputs, here: (s) => s.id === 'w2' || s.id === 'w6' });
assert.deepStrictEqual(mine.spaces.filter((x) => x.here).map((x) => x.id).sort(), ['w2', 'w6'], "this window's spaces are marked");
assert.deepStrictEqual(mine.spaces.map((x) => x.id), all.spaces.map((x) => x.id), 'every space is still listed, in the same order');
assert.ok(all.spaces.every((x) => !x.here), 'without here(), no space is marked');
// Needs you: only this window's agents (space here, or a tab open here); none when the section is off
const waitingSpaces = new Set(model.spaces.filter((x) => x.agents.length).map((x) => x.id));
const allDone = (x: (typeof model.spaces)[number]) => {
  const tabs = x.tabs.map((t) => ({ ...t, panes: t.panes.map((p) => (p.isAgent ? { ...p, status: 'done' as const } : p)) }));
  return { ...x, tabs, agents: tabs.flatMap((t) => t.panes.filter((p) => p.isAgent)) };
};
const needy = { ...inputs, model: { ...model, spaces: model.spaces.map(allDone) }, needsYou: true };
const allNeedy = buildViewState({ ...needy, here: () => true });
assert.strictEqual(allNeedy.attention.length, 5, 'every agent when every space is here');
const someNeedy = buildViewState({ ...needy, here: (s) => s.id === 'w2' });
assert.ok(someNeedy.attention.length > 0 && someNeedy.attention.every((a) => a.spaceId === 'w2'), "only the agents of this window's spaces");
const otherAgent = needy.model.spaces.find((x) => x.id !== 'w2' && x.agents.length)!.agents[0].id;
const withTab = buildViewState({ ...needy, here: (s) => s.id === 'w2', attached: (id) => id === otherAgent });
assert.ok(withTab.attention.some((a) => a.id === otherAgent), 'an agent whose tab is open here counts too');
assert.deepStrictEqual(buildViewState({ ...needy, here: () => false }).attention, [], 'no space here: nothing');
const off = buildViewState({ ...needy, here: () => true, needsYou: false });
assert.deepStrictEqual([off.attention, off.needsYou, allNeedy.needsYou], [[], false, true], 'the section can be turned off');
assert.strictEqual(buildViewState({ ...needy, needsYou: undefined }).needsYou, false, 'off by default, like the herdr.showNeedsYou setting');
assert.ok(off.spaces.flatMap((x) => x.agents).every((a) => a.needs), 'with the section off, waiting agents are framed in their space');
assert.ok(allNeedy.spaces.flatMap((x) => x.agents).every((a) => !a.needs), 'with it on, they are not');
assert.ok(off.spaces.flatMap((x) => x.agents).every((a) => a.framed), 'agents needing you are framed in their space');
const allWorking = (x: (typeof model.spaces)[number]) => {
  const tabs = x.tabs.map((t) => ({ ...t, panes: t.panes.map((p) => (p.isAgent ? { ...p, status: 'working' as const } : p)) }));
  return { ...x, tabs, agents: tabs.flatMap((t) => t.panes.filter((p) => p.isAgent)) };
};
const working = buildViewState({ ...needy, model: { ...model, spaces: model.spaces.map(allWorking) } });
const workingAgents = working.spaces.flatMap((x) => x.agents);
assert.ok(workingAgents.length > 0 && workingAgents.every((a) => a.framed && !a.needs), 'working agents are framed (blue) whether or not Needs you is on');
assert.ok(buildViewState(inputs).spaces.flatMap((x) => x.agents).filter((a) => a.status === 'idle').every((a) => !a.framed), 'idle agents are not');
assert.ok(waitingSpaces.size > 1);
console.log('✓ Needs you lists only this window\'s agents, and can be turned off');
console.log("✓ spaces open in this window are marked for the This window group");
const ownWindow = buildViewState({ ...inputs, here: () => false, thisWindow: { name: 'my-repo' } });
assert.deepStrictEqual(ownWindow.thisWindow, { name: 'my-repo' }, "a window with folders of its own says so (the sidebar shows its 'no space' card)");
assert.strictEqual(all.thisWindow, undefined, 'the Cockpit window or an empty one: no This window card');
console.log('✓ a window with its own folders is marked for the "no space here" card');
{
  // A shell prompt title ("user@host:~/path") isn't shown as an agent's detail: noise, and it has the user name.
  const withTitle = (title: string) => {
    const spaces = model.spaces.map((x) => ({ ...x, tabs: x.tabs.map((t) => ({ ...t, panes: t.panes.map((p) => (p.isAgent ? { ...p, title } : p)) })) }));
    return buildViewState({ ...inputs, model: { ...model, spaces } }).spaces.flatMap((x) => x.agents).map((a) => a.detail);
  };
  assert.ok(withTitle('dev@box:~/code/app').every((d) => d === undefined), 'user@host:~/path dropped');
  assert.ok(withTitle('dev@box.local: /srv/app').every((d) => d === undefined), 'user@host: /path dropped');
  assert.ok(withTitle('Fix the login bug').some((d) => d === 'Fix the login bug'), 'a real task title stays');
  console.log('✓ shell prompt titles are not shown as details');
}

// ---- new worktrees start from the repo's own space, not from another worktree's
{
  const sp = (id: string, cwd: string, worktree?: Space['worktree']) => ({ id, label: id, cwd, worktree }) as unknown as Space;
  const main = sp('m', '/r/app');
  const wt = sp('w', '/wt/app/feat', { checkout_path: '/wt/app/feat', is_linked_worktree: true, repo_key: 'k', repo_name: 'app', repo_root: '/r/app' });
  const managedMain = sp('mm', '/r/lib', { checkout_path: '/r/lib', is_linked_worktree: false, repo_key: 'lib', repo_name: 'lib', repo_root: '/r/lib' });
  const wtLib = sp('wl', '/wt/lib/x', { checkout_path: '/wt/lib/x', is_linked_worktree: true, repo_key: 'lib', repo_name: 'lib', repo_root: '/r/lib' });
  const orphan = sp('o', '/wt/gone/y', { checkout_path: '/wt/gone/y', is_linked_worktree: true, repo_key: 'gone', repo_name: 'gone', repo_root: '/r/gone' });
  const all = [main, wt, managedMain, wtLib, orphan];
  assert.strictEqual(repoSpace(all, main), main, 'a plain space is its own');
  assert.strictEqual(repoSpace(all, wt), main, "a worktree's repo space found by its folder");
  assert.strictEqual(repoSpace(all, wtLib), managedMain, "a worktree's repo space found by repo key");
  assert.strictEqual(repoSpace(all, orphan), undefined, 'no repo space open: none');
  console.log("✓ new worktrees start from the repo's own space");

  // The card's folder line: the folder, and for a worktree, the repo it's a checkout of
  assert.strictEqual(shortPath('~/repos/personal/my-app'), '~/repos/personal/my-app');
  assert.strictEqual(shortPath('~/a/b/c/d/my-app'), '~/…/d/my-app');
  assert.strictEqual(shortPath('/srv/project'), '/srv/project');
  assert.strictEqual(shortPath('/a/b/c/d/e'), '/…/d/e');
  assert.deepStrictEqual(folderLine(main, all), { text: '/r/app' });
  assert.deepStrictEqual(folderLine(wt, all), { text: '/wt/app/feat', worktreeOf: 'm' }, 'named after its repo space');
  assert.deepStrictEqual(folderLine(orphan, all), { text: '/wt/gone/y', worktreeOf: 'gone' }, "no repo space: Herdr's repo name");
  assert.strictEqual(folderLine(sp('x', ''), all), undefined, 'no folder known: no line');
  console.log('✓ space cards show their folder, and a worktree its repo');
}

// ---- decisions the sidebar draws: layout split, default folding, rows, usage
{
  const card = (id: string, here: boolean) => ({ id, here }) as any;
  assert.deepStrictEqual(spacesLayout([card('a', true), card('b', false)], undefined), { split: true, othersOpenByDefault: false });
  assert.deepStrictEqual(spacesLayout([card('a', true)], undefined), { split: false, othersOpenByDefault: false }, 'only this window: plain list');
  assert.deepStrictEqual(spacesLayout([card('b', false)], undefined), { split: false, othersOpenByDefault: false }, 'Cockpit or empty window: plain list');
  assert.deepStrictEqual(spacesLayout([card('b', false)], { name: 'repo' }), { split: true, othersOpenByDefault: true, noSpaceHere: { name: 'repo', canAdd: true } });
  assert.deepStrictEqual(spacesLayout([], { name: 'repo' }).noSpaceHere, { name: 'repo', canAdd: false }, 'nothing to add');
  console.log('✓ spaces layout: split, no-space card, other spaces unfolded');

  const v = buildViewState({ ...inputs, mounted: (sp) => sp.id === 'w2' });
  const w2 = v.spaces.find((x) => x.id === 'w2')!;
  assert.ok(w2.defaultOpen, 'a space open here starts unfolded');
  assert.strictEqual(w2.shellsDefaultOpen, w2.shells.length <= 3);
  assert.ok(w2.agents.every((a) => a.spaceMounted && a.spaceLabel === w2.label), 'rows know their space');
  const src = model.spaces.find((x) => x.id === 'w2')!;
  assert.ok(w2.agents.every((a, n) => a.cwd === undefined || src.agents[n]?.cwd !== src.cwd), "a pane in the space's own folder doesn't repeat it");
  console.log('✓ rows: space name, mounted, own folder only; spaces fold by default');

  const u = usageView({ id: 'codex', name: 'Codex', plan: 'team', windows: [{ label: '7d', usedPercent: 61 }, { label: '5h', usedPercent: 90 }] });
  assert.deepStrictEqual([u.planName, u.summary, u.windows.map((w) => w.level)], ['Business', { text: '5h 90%', level: 'high' }, ['warn', 'high']]);
  assert.deepStrictEqual(usageView({ id: 'kiro', name: 'Kiro', windows: [], credits: { month: 12.34, today: 1, limit: 0 } } as any).summary, { text: '12.3 cr', level: 'ok' });
  assert.deepStrictEqual(usageView({ id: 'claude', name: 'Claude', plan: 'max', windows: [], block: { tokens: 1_500_000 } } as any).summary.text, '1.5M tok');
  assert.strictEqual(usageView({ id: 'claude', name: 'Claude', plan: 'max', windows: [] }).planName, 'Max');
  console.log('✓ usage: plan names, levels, folded summary');
  assert.deepStrictEqual([ago(4_400), ago(61_000), ago(80 * 60_000), ago(120 * 60_000), ago(50 * 3_600_000)], ['4s', '1m', '1h 20m', '2h', '2d']);
  assert.deepStrictEqual([left(30_000), left(24 * 60_000), left(80 * 60_000), left(71 * 3_600_000), left(48 * 3_600_000)], ['1m', '24m', '1h 20m', '2d 23h', '2d']);
  console.log('✓ short durations');
}

// ---- switching to a space opens every pane: agents by urgency, then shells in tab order
const ka = model.spaces.find((x) => x.id === 'w2')!;
assert.deepStrictEqual(attachOrder(ka, true).map((p) => p.id), ['w2:p1', 'w2:p5', 'w2:p7', 'w2:p8', 'w2:p9', 'w2:pA', 'w2:pC']);
assert.deepStrictEqual(attachOrder(ka, false).map((p) => p.id), ['w2:p1']);
const mixed = { ...ka, agents: ['idle', 'blocked', 'working', 'done'].map((status, n) => ({ ...ka.agents[0], id: `a${n}`, status: status as any })) };
assert.deepStrictEqual(attachOrder(mixed, false).map((p) => p.status), ['blocked', 'done', 'working', 'idle']);
console.log('✓ attach order');

// ---- model helpers: every pane, one pane, counts, who's waiting on you
assert.strictEqual(allPanes(model).length, 15, '5 agents and 10 shells');
assert.strictEqual(findPane(model, 'w2:p8')?.space.id, 'w2');
assert.strictEqual(findPane(model, 'nope'), undefined);
assert.strictEqual(findPane(model, undefined), undefined);
assert.strictEqual(Object.values(countByStatus(model)).reduce((a, b) => a + b, 0), 5);
const waitingModel = {
  ...model,
  spaces: [
    { ...ka, tabs: [{ ...ka.tabs[0], panes: ['done', 'idle', 'blocked', 'done'].map((status, n) => ({ ...ka.agents[0], id: `x${n}`, status: status as any })) }] },
  ],
};
waitingModel.spaces[0].agents = waitingModel.spaces[0].tabs[0].panes;
assert.deepStrictEqual(needingAttention(waitingModel).map((x) => x.pane.id), ['x2', 'x0', 'x3'], 'blocked first, then done in Herdr order');
assert.deepStrictEqual(countByStatus(waitingModel), { idle: 1, working: 0, blocked: 1, done: 2, unknown: 0 });
console.log('✓ model helpers');

// ---- agent display names: generated names read as titles, chosen names as-is
const named = (name: string | null, kind = 'claude', display: string | null = null, terminalTitle?: string) =>
  paneName(undefined, { ...ka.agents[0], agentKind: kind, terminalTitle, raw: { agent: { ...ka.agents[0].raw.agent!, agent: kind, name, display_agent: display } } });
assert.deepStrictEqual(
  [named(null), named('claude'), named('claude-2'), named('reviewer'), named(null, 'agy'), named('claude', 'claude', 'Claude (auth)')],
  ['Claude', 'Claude', 'Claude 2', 'reviewer', 'Antigravity', 'Claude (auth)'],
);
// The session name from the terminal title beats a generated name, not a chosen one; default and path titles don't count.
assert.deepStrictEqual(
  [named('claude-2', 'claude', null, 'Fix date formatting'), named('reviewer', 'claude', null, 'Fix date formatting'), named('claude-3', 'claude', null, 'Claude Code'), named('kiro', 'kiro', null, 'kiro: ~/code/dashboard'), named('claude', 'claude', null, '~/code/api')],
  ['Fix date formatting', 'reviewer', 'Claude 3', 'Kiro', 'Claude'],
);
// herdr.agentNames = herdr: only Herdr's names.
setAgentNames('herdr');
assert.deepStrictEqual([named('claude-2', 'claude', null, 'Fix date formatting'), named('reviewer', 'claude', null, 'Fix date formatting')], ['Claude 2', 'reviewer']);
setAgentNames('title');
console.log('✓ agent display names');

// ---- generated agent logos cover the agents in use
const sandbox: { window: { HERDR_AGENT_ICONS?: Record<string, string> } } = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'agent-icons.js'), 'utf8'), sandbox);
const logos = sandbox.window.HERDR_AGENT_ICONS!;
for (const k of ['claude', 'codex', 'kiro', 'cursor', 'copilot', 'gemini', 'opencode', 'antigravity_cli'])
  assert.match(logos[k] ?? '', /^<svg class="agent-logo"/, `logo for ${k}`);
assert.ok(Object.values(logos).every((s) => !/<script|\son[a-z]+=|style=/i.test(s)), 'logos are inert');
console.log('✓ agent logos');
// Space order: busy (an agent working or waiting on you) first, then the most recently active, then Herdr's order.
const space = (id: string, statuses: string[]) => ({ id, label: id, agents: statuses.map((status) => ({ status })) }) as any;
const at: Record<string, number> = { a: 5, b: 9, c: 1, d: 3 };
const ordered = orderByActivity([space('a', ['idle']), space('b', []), space('c', ['working']), space('d', ['blocked', 'idle']), space('e', ['done']), space('f', [])], (s) => at[s.id]);
assert.deepStrictEqual(ordered.map((s) => s.id), ['d', 'c', 'b', 'a', 'e', 'f']);
console.log('✓ space order: working / blocked first, then most recently active, then Herdr order');
// The Usage section's Today line and Codex credits
assert.deepStrictEqual(
  todayLines({ id: 'claude', name: 'Claude Code', windows: [], today: { tokens: 200_000, cacheRead: 1_800_000, costUSD: 12.4, linesAdded: 4536, linesRemoved: 141 } }),
  ['Today: 2.0M tokens, 90% from cache', '$12.40 if billed per token', '+4,536 −141 lines of code'],
);
assert.deepStrictEqual(todayLines({ id: 'codex', name: 'Codex', windows: [], today: { tokens: 1400, cacheRead: 0 } }), ['Today: 1k tokens'], 'no cache share, cost or lines: left out');
assert.deepStrictEqual(todayLines({ id: 'codex', name: 'Codex', windows: [] }), []);
assert.strictEqual(usageView({ id: 'codex', name: 'Codex', windows: [], codexCredits: { balance: 12.5, unlimited: false } }).creditsText, '12.5 credits left');
assert.strictEqual(usageView({ id: 'codex', name: 'Codex', windows: [], codexCredits: { unlimited: true } }).creditsText, 'unlimited credits');
console.log('✓ usage: the Today line and Codex credits');

console.log('\nview tests passed');
