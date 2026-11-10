// Pure tests for shell/agent summaries and the sidebar view state. Inputs are real outputs
// captured from herdr 0.9.1 panes. No VS Code or socket needed.
import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { describeProcess, isShellProcess, summarizeAgent, summarizeShell } from '../activity';
import * as vm from 'vm';
import { attachOrder, normalize } from '../model';
import { buildViewState, headline, orderByActivity, paneName, setAgentNames } from '../viewState';
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

// ---- switching to a space opens every pane: agents by urgency, then shells in tab order
const ka = model.spaces.find((x) => x.id === 'w2')!;
assert.deepStrictEqual(attachOrder(ka, true).map((p) => p.id), ['w2:p1', 'w2:p5', 'w2:p7', 'w2:p8', 'w2:p9', 'w2:pA', 'w2:pC']);
assert.deepStrictEqual(attachOrder(ka, false).map((p) => p.id), ['w2:p1']);
const mixed = { ...ka, agents: ['idle', 'blocked', 'working', 'done'].map((status, n) => ({ ...ka.agents[0], id: `a${n}`, status: status as any })) };
assert.deepStrictEqual(attachOrder(mixed, false).map((p) => p.status), ['blocked', 'done', 'working', 'idle']);
console.log('✓ attach order');

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
console.log('\nview tests passed');
