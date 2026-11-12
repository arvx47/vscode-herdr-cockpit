// Standalone test: fake herdr socket server (mockHerdr.ts) + real client + normalizer. No VS Code needed.
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';
import { HerdrClient, HerdrError, DEFAULT_SUBSCRIPTIONS, expandHome, subscriptionsFor } from '../herdrClient';
import { normalize } from '../model';
import { ActivityWatcher } from '../activity';
import { HerdrActions, agentName, agentSlug, agentTitle, resumeArgs } from '../herdrActions';
import { MockHerdr, pane, snap, tab, validate, ws } from './mockHerdr';

import type { AgentInfo, PaneInfo, SessionSnapshotResult } from '../herdrTypes';

const sock = path.join(os.tmpdir(), `herdr-mock-${process.pid}.sock`);

// Real `herdr api snapshot` output (herdr 0.9.1, protocol 22), saved verbatim.
const fixture: { result: SessionSnapshotResult } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'snapshot-herdr-0.9.1.json'), 'utf8'),
);

const agent = (p: PaneInfo, extra: Partial<AgentInfo>): AgentInfo => ({ ...p, agent_status: 'idle', ...extra });

const paneA1 = pane('w1:p1', 'w1:t1', { focused: true, cwd: '/repo/api', agent: 'claude' });
const paneB1 = pane('w2:p1', 'w2:t1', { cwd: '/repo/web', foreground_cwd: '/repo/web/pkg', agent: 'codex' });
const snapA = snap({
  version: '0.9.1',
  focused_workspace_id: 'w1',
  focused_pane_id: 'w1:p1',
  workspaces: [ws('w1', 'api'), ws('w2', 'web')],
  tabs: [tab('w1:t1', 'main'), tab('w2:t1', 'main'), tab('w2:t2', 'logs')],
  panes: [paneA1, pane('w1:p2', 'w1:t1', { cwd: '/repo/api' }), paneB1, pane('w2:p2', 'w2:t2', { cwd: '/repo/web' })],
  agents: [agent(paneA1, { name: 'reviewer', agent_status: 'working' }), agent(paneB1, { agent_status: 'blocked' })],
});

const snapshot = snapA;
let reads = 0;
let busyStarts = 2;
/** What the next session.snapshot answers with instead of the snapshot (a raw line), once. */
let rawNext: string | undefined;
const mock = new MockHerdr({
  socket: sock,
  snapshot: () => snapshot,
  handlers: {
    'session.snapshot': (req, _reply, c) => {
      if (rawNext !== undefined) {
        c.write(rawNext + '\n');
        rawNext = undefined;
        return;
      }
      // split the response across two writes to test line buffering
      const s = JSON.stringify({ id: req.id, result: snapshot }) + '\n';
      c.write(s.slice(0, 7));
      setTimeout(() => c.write(s.slice(7)), 5);
    },
    'workspace.focus': (req, reply) => {
      if (!snapshot.snapshot.workspaces.find((w) => w.workspace_id === req.params.workspace_id)) {
        reply({ error: { code: 'not_found', message: 'workspace not found' } });
        return;
      }
      snapshot.snapshot.focused_workspace_id = req.params.workspace_id;
      reply({ result: { type: 'ok' } });
    },
    'pane.process_info': (req, reply) =>
      reply({ result: { type: 'pane_process_info', process_info: {
        pane_id: req.params.pane_id, foreground_process_group_id: 42,
        foreground_processes: [{ pid: 42, name: 'Python', argv: ['/usr/local/bin/Python', 'app.py'] }],
      } } }),
    'pane.read': (req, reply) => {
      assert.ok(['recent_unwrapped', 'detection'].includes(req.params.source));
      reply({ result: { type: 'pane_read', read: {
        pane_id: req.params.pane_id, workspace_id: 'w1', tab_id: 'w1:t1', source: req.params.source, format: 'text',
        revision: 0, truncated: false, text: `GET / 200\nGET /x 500 Internal Server Error\n${reads++}`,
      } } });
    },
    'workspace.create': (req, reply) =>
      reply({ result: { type: 'workspace_created',
        workspace: ws('w9', req.params.label ?? 'new'), tab: tab('w9:t1', '1'),
        root_pane: pane('w9:p1', 'w9:t1', { cwd: req.params.cwd }) } }),
    'tab.create': (req, reply) =>
      reply({ result: { type: 'tab_created', tab: tab(`${req.params.workspace_id}:t7`, req.params.label ?? '7'),
        root_pane: pane(`${req.params.workspace_id}:p7`, `${req.params.workspace_id}:t7`) } }),
    'worktree.create': (req, reply) =>
      reply({ result: { type: 'worktree_created', workspace: ws('w8', req.params.branch), tab: tab('w8:t1', '1'),
        root_pane: pane('w8:p1', 'w8:t1'),
        worktree: { path: '/wt/x', branch: req.params.branch, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: req.params.branch } } }),
    'agent.start': (req, reply) => {
      // A brand-new pane isn't at its prompt yet: Herdr answers busy until it is.
      if (busyStarts > 0) {
        busyStarts--;
        reply({ error: { code: 'agent_pane_busy', message: `agent target pane ${req.params.pane_id} is not an available shell` } });
        return;
      }
      // agent.start blocks until the agent is ready; answer after the client's default 5s would have passed.
      setTimeout(() => reply({ result: { type: 'agent_started', argv: [req.params.kind],
        agent: { ...pane(req.params.pane_id, 'w1:t7', { agent: req.params.kind }), agent_status: 'idle', name: req.params.name } } }), 5200);
    },
    'agent.prompt': (req, reply) =>
      reply({ result: { type: 'agent_prompted', agent: { ...pane(req.params.target, 'w1:t1', { agent: 'claude' }), agent_status: 'working', name: 'claude' } } }),
    'server.agent_manifests': (_req, reply) =>
      reply({ result: { type: 'agent_manifest_status', manifests: ['claude', 'codex', 'gemini'].map((a) => ({ agent: a, source: 'remote', source_kind: 'remote', local_override_shadowing_remote: false })) } }),
    'worktree.remove': (req, reply) =>
      reply({ result: { type: 'worktree_removed', workspace_id: req.params.workspace_id, path: '/wt/x', forced: !!req.params.force } }),
  },
});
/** The newest live subscriber connection. */
const subscriber = () => [...mock.subscribers].pop() as net.Socket;
/** Requests the mock accepted for the create/start/rename/close methods, in order. */
const ACTION_METHODS = new Set([
  'workspace.create', 'tab.create', 'worktree.create', 'agent.start', 'agent.prompt', 'tab.rename', 'tab.close',
  'workspace.rename', 'workspace.close', 'worktree.remove', 'pane.split', 'pane.rename', 'agent.rename', 'pane.close',
]);
const calls = () => mock.requests.filter((r) => ACTION_METHODS.has(r.method) && !(r.method === 'agent.start' && r !== lastStart()));
const lastStart = () => mock.calls('agent.start').pop();

async function main() {
  await mock.start();
  const client = new HerdrClient(() => sock);

  // 1. snapshot + normalize (synthetic, schema-typed)
  const m = normalize(await client.request<SessionSnapshotResult>('session.snapshot'));
  assert.strictEqual(m.spaces.length, 2);
  assert.strictEqual(m.focusedSpaceId, 'w1');
  const api = m.spaces.find((s) => s.id === 'w1')!;
  assert.strictEqual(api.cwd, '/repo/api');
  assert.strictEqual(api.agents.length, 1);
  assert.strictEqual(api.agents[0].label, 'reviewer');
  assert.strictEqual(api.agents[0].status, 'working');
  assert.strictEqual(api.agents[0].terminalId, 'term_w1:p1');
  assert.strictEqual(api.tabs[0].panes.find((p) => p.id === 'w1:p2')!.isAgent, false);
  assert.strictEqual(api.tabs[0].panes.find((p) => p.id === 'w1:p2')!.status, undefined, 'shells have no status');
  const web = m.spaces.find((s) => s.id === 'w2')!;
  assert.strictEqual(web.cwd, '/repo/web/pkg', 'cwd falls back to first pane (foreground_cwd preferred)');
  assert.strictEqual(web.status, 'blocked', 'rollup');
  assert.strictEqual(web.tabs.length, 2);
  console.log('✓ synthetic snapshot normalizes');

  // 2. real snapshot from herdr 0.9.1
  const real = normalize(fixture.result);
  assert.strictEqual(real.spaces.length, 6);
  assert.strictEqual(real.focusedSpaceId, 'w6');
  for (const w of fixture.result.snapshot.workspaces) {
    const sp = real.spaces.find((x) => x.id === w.workspace_id)!;
    assert.strictEqual(sp.label, w.label);
    assert.strictEqual(sp.tabs.length, w.tab_count, `${w.workspace_id} tab_count`);
    assert.strictEqual(sp.tabs.flatMap((t) => t.panes).length, w.pane_count, `${w.workspace_id} pane_count`);
  }
  const allPanes = real.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes));
  assert.deepStrictEqual(allPanes.filter((p) => p.isAgent).map((p) => `${p.id}=${p.agentKind}/${p.status}`).sort(), [
    'w2:p1=claude/idle', 'w4:p1=kiro/idle', 'w5:p1=kiro/idle', 'w6:p1=claude/idle', 'w7:p1=claude/idle',
  ]);
  const ka = real.spaces.find((s) => s.id === 'w2')!;
  assert.strictEqual(ka.cwd, '/Users/dev/code/api-service');
  assert.strictEqual(ka.agents[0].label, 'Add pagination to the orders API', 'falls back to stripped terminal title');
  assert.strictEqual(ka.agents[0].session, '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(allPanes.find((p) => p.id === 'w2:p8')!.label, 'reviewr', 'shell pane label');
  assert.strictEqual(allPanes.find((p) => p.id === 'w6:p1')!.focused, true);
  const lm = real.spaces.find((s) => s.id === 'w8')!;
  assert.strictEqual(lm.status, undefined, 'no agents -> no rollup');
  assert.strictEqual(lm.agents.length, 0);
  console.log('✓ real herdr 0.9.1 snapshot normalizes');

  // 2b. metadata: display_agent, state_labels, tokens, done, worktree
  const metaPane = pane('w9:p1', 'w9:t1', {
    agent: 'claude', terminal_title_stripped: 'claude: fixing tests', display_agent: 'Claude: auth',
    state_labels: { working: 'refactoring auth', done: 'review ready' }, tokens: { summary: 'refactor auth' },
    agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'abc' },
  });
  const mc = normalize(snap({
    focused_workspace_id: 'w9',
    workspaces: [ws('w9', 'meta', {
      worktree: { checkout_path: '/m/wt', is_linked_worktree: true, repo_key: 'k', repo_name: 'm', repo_root: '/m' },
      tokens: { jj_status: '2 changes' },
    })],
    tabs: [tab('w9:t1', 'main')],
    panes: [metaPane],
    agents: [agent(metaPane, { agent_status: 'done', tokens: { model: 'opus' } })],
  }));
  const ag = mc.spaces[0].agents[0];
  assert.strictEqual(ag.label, 'Claude: auth');
  assert.strictEqual(ag.status, 'done');
  assert.strictEqual(ag.stateLabel, 'review ready');
  assert.strictEqual(ag.tokens.summary, 'refactor auth', 'pane tokens');
  assert.strictEqual(ag.tokens.model, 'opus', 'agent tokens merged');
  assert.strictEqual(ag.terminalTitle, 'claude: fixing tests');
  assert.strictEqual(ag.session, 'abc');
  assert.strictEqual(mc.spaces[0].cwd, '/m/wt', 'worktree checkout_path is the space cwd');
  assert.strictEqual(mc.spaces[0].worktree?.is_linked_worktree, true);
  assert.strictEqual(mc.spaces[0].tokens.jj_status, '2 changes');
  assert.strictEqual(mc.spaces[0].counts.done, 1);
  console.log('✓ metadata: labels, tokens, done, worktree');

  // 2c. a response that isn't a snapshot fails loudly instead of rendering an empty tree
  assert.throws(() => normalize({ type: 'ok' } as any), /unexpected session.snapshot shape/);
  console.log('✓ malformed snapshot rejected');

  // 3. error path
  await assert.rejects(client.request('workspace.focus', { workspace_id: 'nope' }), (e: any) => e instanceof HerdrError && e.code === 'not_found');
  await client.request('workspace.focus', { workspace_id: 'w2' });
  assert.strictEqual(normalize(await client.request<SessionSnapshotResult>('session.snapshot')).focusedSpaceId, 'w2');
  console.log('✓ requests, errors, focus');

  // 3b. pane activity via pane.process_info + pane.read
  const watcher = new ActivityWatcher(client);
  assert.strictEqual(await watcher.poll([{ paneId: 'w1:p2', kind: 'shell' }]), true);
  const act = watcher.get('w1:p2')!;
  assert.strictEqual(act.state, 'running');
  assert.strictEqual(act.command, 'python app.py');
  assert.strictEqual(act.failed, true, 'error in output');
  assert.strictEqual(act.changedAt, undefined, 'no change seen yet');
  await watcher.poll([{ paneId: 'w1:p2', kind: 'shell' }]);
  assert.ok(watcher.get('w1:p2')!.changedAt, 'output changed between polls');
  await watcher.poll([]);
  assert.strictEqual(watcher.get('w1:p2'), undefined, 'forgets panes that are gone');
  console.log('✓ pane activity (process_info + read)');

  // 3c. create / start / rename / close
  const actions = new HerdrActions(client);
  const sp9 = await actions.createSpace({ cwd: '/repo/new', label: 'new' });
  assert.deepStrictEqual([sp9.workspace.workspace_id, sp9.pane.pane_id, sp9.pane.terminal_id], ['w9', 'w9:p1', 'term_w9:p1']);
  const t7 = await actions.createTab({ workspace_id: 'w1', cwd: '/repo/api' });
  assert.deepStrictEqual([t7.tab.tab_id, t7.pane.pane_id], ['w1:t7', 'w1:p7']);
  const wt = await actions.createWorktreeSpace({ workspace_id: 'w1', branch: 'feat/y' });
  assert.strictEqual(wt.worktree.branch, 'feat/y');
  const started = await actions.startAgent('w1:p7', 'claude', agentName('claude', ['claude']), resumeArgs('claude', { agent: 'claude', kind: 'id', source: 'hook', value: 'abc-123' }));
  assert.deepStrictEqual([started.agent, started.name], ['claude', 'claude-2'], 'agent.start outlives the 5s default timeout');
  const prompted = await actions.promptAgent('w1:p1', 'fix the failing test');
  assert.strictEqual(prompted.agent_status, 'working');
  assert.deepStrictEqual(await actions.agentKinds(), ['claude', 'codex', 'gemini']);
  await actions.renameTab('w1:t7', 'tests');
  await actions.closeTab('w1:t7');
  await actions.renameSpace('w9', 'renamed');
  await actions.closeSpace('w9');
  await actions.closeSpace('w9', true);
  await actions.removeWorktree('w8');
  await actions.removeWorktree('w8', true);
  const split = await actions.splitPane({ target_pane_id: 'w1:p1', direction: 'right' });
  assert.strictEqual(split.tab_id, 'w1:t1', 'the split pane is in the same tab');
  await actions.renamePane('w1:p2', 'server');
  await actions.renamePane('w1:p2', null);
  await actions.renameAgent('w1:p1', 'reviewer-2');
  await actions.closePane('w1:p2');
  assert.deepStrictEqual(
    calls().map((c) => [c.method, c.params]),
    [
      ['workspace.create', { focus: false, cwd: '/repo/new', label: 'new' }],
      ['tab.create', { focus: false, workspace_id: 'w1', cwd: '/repo/api' }],
      ['worktree.create', { focus: false, workspace_id: 'w1', branch: 'feat/y' }],
      ['agent.start', { pane_id: 'w1:p7', kind: 'claude', name: 'claude-2', timeout_ms: 60000, args: ['--resume', 'abc-123'] }],
      ['agent.prompt', { target: 'w1:p1', text: 'fix the failing test' }],
      ['tab.rename', { tab_id: 'w1:t7', label: 'tests' }],
      ['tab.close', { tab_id: 'w1:t7' }],
      ['workspace.rename', { workspace_id: 'w9', label: 'renamed' }],
      ['workspace.close', { workspace_id: 'w9' }],
      ['workspace.close', { workspace_id: 'w9', close_group: true }],
      ['worktree.remove', { workspace_id: 'w8' }],
      ['worktree.remove', { workspace_id: 'w8', force: true }],
      ['pane.split', { focus: false, target_pane_id: 'w1:p1', direction: 'right' }],
      ['pane.rename', { pane_id: 'w1:p2', label: 'server' }],
      ['pane.rename', { pane_id: 'w1:p2', label: null }],
      ['agent.rename', { target: 'w1:p1', name: 'reviewer-2' }],
      ['pane.close', { pane_id: 'w1:p2' }],
    ],
    'creates never steal Herdr focus',
  );
  assert.deepStrictEqual([agentTitle('kiro'), agentTitle('agy'), agentTitle('newagent')], ['Kiro', 'Antigravity', 'Newagent']);
  assert.deepStrictEqual([agentName('claude', []), agentName('claude', ['claude', 'claude-2']), agentName('Mastra Code', [])], ['claude', 'claude-3', 'mastra-code']);
  assert.deepStrictEqual(['Reviewer Bot', '  2nd try!', 'ok_name-1', '???', 'É'].map(agentSlug), ['reviewer-bot', 'nd-try', 'ok_name-1', undefined, undefined]);
  assert.deepStrictEqual(
    [
      resumeArgs('codex', { agent: 'codex', kind: 'id', source: 'hook', value: 's1' }),
      resumeArgs('claude', { agent: 'claude', kind: 'path', source: 'hook', value: '/x.jsonl' }),
      resumeArgs('kiro', { agent: 'kiro', kind: 'id', source: 'hook', value: 's1' }),
      resumeArgs('claude', undefined),
      resumeArgs('Claude', { agent: 'claude', kind: 'id', source: 'hook', value: 'c1' }),
    ],
    [['resume', 's1'], undefined, undefined, undefined, ['--resume', 'c1']],
    'resumes only agents whose CLI takes a session id',
  );
  console.log('✓ create space/tab/worktree, start agent, split, rename, close');

  // 3d. the mock refuses what Herdr refuses, so a wrapper sending bad params fails here first
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof HerdrError ? `${e.code}: ${e.message}` : String(e)));
  assert.match(await code(client.request('worktree.create', { workspace_id: 'w1', cwd: '/repo', branch: 'x' })), /only one of workspace_id or cwd may be supplied/);
  assert.match(await code(client.request('worktree.create', { workspace_id: 'w1' })), /exactly one of path or branch is required/);
  assert.match(await code(client.request('worktree.create', { cwd: '/repo', branch: 'x', path: '/wt' })), /exactly one of path or branch is required/);
  assert.match(await code(client.request('agent.start', { pane_id: 'w1:p1', kind: 'claude', name: 'Claude 2' })), /agent name/);
  assert.match(await code(client.request('agent.start', { pane_id: 'w1:p1', kind: 'claude', name: 'claude', timeout_ms: 3000 })), /timeout_ms/);
  assert.match(await code(client.request('agent.start', { pane_id: 'w1:p1', kind: 'claude', name: 'claude', timeout_ms: 300_001 })), /timeout_ms/);
  assert.match(await code(client.request('agent.start', { pane_id: 'w1:p1', name: 'claude' })), /missing field `kind`/);
  assert.match(await code(client.request('agent.prompt', { target: 'w1:p1', text: '  ' })), /^empty_agent_prompt/);
  assert.match(await code(client.request('pane.split', { target_pane_id: 'w1:p1', direction: 'left' })), /unknown direction/);
  assert.match(await code(client.request('pane.close', {})), /missing field `pane_id`/);
  assert.match(await code(actions.closePane('w9:p9')), /^pane_not_found/);
  assert.match(await code(actions.renameAgent('w1:p1', 'Not Valid')), /agent name/);
  // Our own wrappers' params pass (the type narrows worktree.create to one source and one of branch/path).
  assert.strictEqual(validate('worktree.create', { focus: false, cwd: '/repo', path: '/wt/existing' }), undefined);
  assert.strictEqual(validate('agent.start', { pane_id: 'w1:p1', kind: 'claude', name: 'claude-2', timeout_ms: 60_000, args: ['--resume', 'x'] }), undefined);
  console.log('✓ mock validates params like Herdr (worktree.create, agent.start, agent.prompt, required fields)');

  // 3e. a response that isn't JSON fails the request at once (it used to be dropped and look like a timeout)
  rawNext = '<html>not json</html>';
  const t0 = Date.now();
  await assert.rejects(client.request('session.snapshot'), /session\.snapshot: malformed line from herdr/);
  assert.ok(Date.now() - t0 < 1000, 'rejected without waiting for the timeout');
  console.log('✓ malformed response rejects the request');

  // 3f. `~` expands only on its own or as `~/`
  assert.deepStrictEqual(
    [expandHome('~'), expandHome('~/x/herdr.sock'), expandHome('~foo/x'), expandHome('/abs/~/x')],
    [os.homedir(), path.join(os.homedir(), 'x', 'herdr.sock'), '~foo/x', '/abs/~/x'],
  );
  console.log('✓ home expansion (~ and ~/ only)');

  // 4. subscription: ack is swallowed, events delivered, close reported
  const events: any[] = [];
  const ended = new Promise<void>((resolve) => {
    client.subscribe(DEFAULT_SUBSCRIPTIONS, (e) => events.push(e), () => resolve());
  });
  await new Promise((r) => setTimeout(r, 50));
  subscriber().write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } }) + '\n');
  subscriber().write(JSON.stringify({ event: 'workspace.focused', data: { workspace_id: 'w1' } }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  subscriber().end();
  await ended;
  assert.strictEqual(events.length, 2);
  console.log('✓ event subscription (ack, events, close)');

  // 5. events_lost error ends subscription with error
  const err = await new Promise<Error | undefined>((resolve) => {
    client.subscribe(DEFAULT_SUBSCRIPTIONS, () => {}, resolve);
    setTimeout(() => subscriber().write(JSON.stringify({ id: 'x', error: { code: 'events_lost', message: 'fell behind' } }) + '\n'), 50);
  });
  assert.ok(err instanceof HerdrError && err.code === 'events_lost');
  console.log('✓ events_lost surfaces as error');

  // 5b. agent status is subscribed per pane: the snapshot's panes are accepted, a stale pane id is not
  const subscribeResult = (subs: Parameters<HerdrClient['subscribe']>[0]) =>
    new Promise<string>((resolve) => {
      const s = client.subscribe(subs, () => {}, (e) => resolve(e instanceof HerdrError ? e.code : 'closed'));
      setTimeout(() => { s.dispose(); resolve('live'); }, 100);
    });
  const livePanes = snapshot.snapshot.panes.map((p) => p.pane_id);
  assert.strictEqual(await subscribeResult(subscriptionsFor(livePanes)), 'live');
  assert.strictEqual(subscriptionsFor(livePanes).filter((x) => x.type === 'pane.agent_status_changed').length, livePanes.length);
  assert.strictEqual(await subscribeResult(subscriptionsFor([...livePanes, 'w9:p9'])), 'pane_not_found');
  console.log('✓ per-pane agent status subscriptions (stale pane id rejected)');

  // 5c. onAck fires once Herdr accepts; an event line that isn't JSON ends the stream (an event lost)
  let acks = 0;
  const badEvent = await new Promise<Error | undefined>((resolve) => {
    client.subscribe(DEFAULT_SUBSCRIPTIONS, () => {}, resolve, { onAck: () => acks++ });
    setTimeout(() => subscriber().write('{not json\n'), 50);
  });
  assert.strictEqual(acks, 1);
  assert.match(String(badEvent?.message), /malformed line from herdr/);
  // A server that never acknowledges: the subscription ends after ackTimeoutMs instead of hanging.
  const silentSock = `${sock}.silent`;
  const silent = net.createServer(() => {});
  await new Promise<void>((r) => silent.listen(silentSock, r));
  const silentClient = new HerdrClient(() => silentSock);
  let silentAcks = 0;
  const noAck = await new Promise<Error | undefined>((resolve) => {
    silentClient.subscribe(DEFAULT_SUBSCRIPTIONS, () => {}, resolve, { onAck: () => silentAcks++, ackTimeoutMs: 100 });
  });
  assert.match(String(noAck?.message), /events\.subscribe timed out/);
  assert.strictEqual(silentAcks, 0);
  silent.close();
  console.log('✓ subscribe ack (onAck), ack timeout, malformed event ends the stream');

  // 6. no server -> rejects quickly
  const dead = new HerdrClient(() => sock + '.missing');
  await assert.rejects(dead.request('ping'));
  console.log('✓ unreachable server rejects');

  await mock.stop();
  try { fs.unlinkSync(sock); } catch {}
  console.log('\nall tests passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
