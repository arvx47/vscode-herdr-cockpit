// Standalone test: fake herdr socket server + real client + normalizer. No VS Code needed.
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';
import { HerdrClient, HerdrError, DEFAULT_SUBSCRIPTIONS, subscriptionsFor } from '../herdrClient';
import { normalize } from '../model';
import { ActivityWatcher } from '../activity';
import { HerdrActions, agentName, agentSlug, agentTitle, resumeArgs } from '../herdrActions';

import type { AgentInfo, PaneInfo, SessionSnapshotResult, TabInfo, WorkspaceInfo } from '../herdrTypes';

const sock = path.join(os.tmpdir(), `herdr-mock-${process.pid}.sock`);
try { fs.unlinkSync(sock); } catch {}

// Real `herdr api snapshot` output (herdr 0.9.1, protocol 22), saved verbatim.
const fixture: { result: SessionSnapshotResult } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'snapshot-herdr-0.9.1.json'), 'utf8'),
);

// Synthetic records typed against the generated schema, so a schema change breaks the build here.
const ws = (workspace_id: string, label: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id, label, number: 1, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${workspace_id}:t1`, agent_status: 'unknown', ...extra,
});
const tab = (tab_id: string, label: string): TabInfo => ({
  tab_id, workspace_id: tab_id.split(':')[0], label, number: 1, focused: false, pane_count: 1, agent_status: 'unknown',
});
const pane = (pane_id: string, tab_id: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id, tab_id, workspace_id: pane_id.split(':')[0], terminal_id: `term_${pane_id}`, focused: false, agent_status: 'unknown', revision: 1, ...extra,
});
const agent = (p: PaneInfo, extra: Partial<AgentInfo>): AgentInfo => ({ ...p, agent_status: 'idle', ...extra });
const snap = (s: Partial<SessionSnapshotResult['snapshot']>): SessionSnapshotResult => ({
  type: 'session_snapshot',
  snapshot: { version: '0.9.1', protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [], ...s },
});

const paneA1 = pane('w1:p1', 'w1:t1', { focused: true, cwd: '/repo/api', agent: 'claude' });
const paneB1 = pane('w2:p1', 'w2:t1', { cwd: '/repo/web', foreground_cwd: '/repo/web/pkg', agent: 'codex' });
const snapA = snap({
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
/** Requests the mock received for the create/rename/close methods, in order. */
const calls: { method: string; params: any }[] = [];
let subscriber: net.Socket | undefined;
const server = net.createServer((c) => {
  c.setEncoding('utf8');
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      const reply = (o: any) => c.write(JSON.stringify({ id: req.id, ...o }) + '\n');
      switch (req.method) {
        case 'session.snapshot':
          // split the response across two writes to test line buffering
          { const s = JSON.stringify({ id: req.id, result: snapshot }) + '\n'; c.write(s.slice(0, 7)); setTimeout(() => c.write(s.slice(7)), 5); }
          break;
        case 'workspace.focus':
          if (!snapshot.snapshot.workspaces.find((w) => w.workspace_id === req.params.workspace_id))
            reply({ error: { code: 'not_found', message: 'workspace not found' } });
          else { snapshot.snapshot.focused_workspace_id = req.params.workspace_id; reply({ result: { type: 'ok' } }); }
          break;
        case 'pane.process_info':
          reply({ result: { type: 'pane_process_info', process_info: {
            pane_id: req.params.pane_id, foreground_process_group_id: 42,
            foreground_processes: [{ pid: 42, name: 'Python', argv: ['/usr/local/bin/Python', 'app.py'] }],
          } } });
          break;
        case 'pane.read':
          assert.ok(['recent_unwrapped', 'detection'].includes(req.params.source));
          reply({ result: { type: 'pane_read', read: {
            pane_id: req.params.pane_id, workspace_id: 'w1', tab_id: 'w1:t1', source: req.params.source, format: 'text',
            revision: 0, truncated: false, text: `GET / 200\nGET /x 500 Internal Server Error\n${reads++}`,
          } } });
          break;
        case 'workspace.create':
          calls.push(req);
          reply({ result: { type: 'workspace_created',
            workspace: ws('w9', req.params.label ?? 'new'), tab: tab('w9:t1', '1'),
            root_pane: pane('w9:p1', 'w9:t1', { cwd: req.params.cwd }) } });
          break;
        case 'tab.create':
          calls.push(req);
          reply({ result: { type: 'tab_created', tab: tab(`${req.params.workspace_id}:t7`, req.params.label ?? '7'),
            root_pane: pane(`${req.params.workspace_id}:p7`, `${req.params.workspace_id}:t7`) } });
          break;
        case 'worktree.create':
          calls.push(req);
          reply({ result: { type: 'worktree_created', workspace: ws('w8', req.params.branch), tab: tab('w8:t1', '1'),
            root_pane: pane('w8:p1', 'w8:t1'),
            worktree: { path: '/wt/x', branch: req.params.branch, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: req.params.branch } } });
          break;
        case 'agent.start':
          // A brand-new pane isn't at its prompt yet: Herdr answers busy until it is.
          if (busyStarts > 0) {
            busyStarts--;
            reply({ error: { code: 'agent_pane_busy', message: `agent target pane ${req.params.pane_id} is not an available shell` } });
            break;
          }
          calls.push(req);
          // agent.start blocks until the agent is ready; answer after the client's default 5s would have passed.
          setTimeout(() => reply({ result: { type: 'agent_started', argv: [req.params.kind],
            agent: { ...pane(req.params.pane_id, 'w1:t7', { agent: req.params.kind }), agent_status: 'idle', name: req.params.name } } }), 5200);
          break;
        case 'agent.prompt':
          calls.push(req);
          reply({ result: { type: 'agent_prompted', agent: { ...pane(req.params.target, 'w1:t1', { agent: 'claude' }), agent_status: 'working', name: 'claude' } } });
          break;
        case 'server.agent_manifests':
          reply({ result: { type: 'agent_manifest_status', manifests: ['claude', 'codex', 'gemini'].map((agent) => ({ agent, source: 'remote', source_kind: 'remote', local_override_shadowing_remote: false })) } });
          break;
        case 'worktree.remove':
          calls.push(req);
          reply({ result: { type: 'worktree_removed', workspace_id: req.params.workspace_id, path: '/wt/x', forced: !!req.params.force } });
          break;
        case 'workspace.rename': case 'workspace.close': case 'tab.rename': case 'tab.close': case 'pane.rename':
          calls.push(req);
          reply({ result: { type: 'ok' } });
          break;
        case 'events.subscribe': {
          // Like herdr 0.9.1: pane-scoped events need a pane_id, and one unknown pane rejects the whole request.
          assert.ok(Array.isArray(req.params.subscriptions));
          const PANE_SCOPED = ['pane.agent_status_changed', 'pane.output_matched', 'pane.scroll_changed'];
          const bad = req.params.subscriptions.find((x: any) => PANE_SCOPED.includes(x.type) && !x.pane_id);
          if (bad) { reply({ error: { code: 'invalid_request', message: 'invalid request: missing field `pane_id`' } }); break; }
          const unknown = req.params.subscriptions.find((x: any) => x.pane_id && !snapshot.snapshot.panes.some((p) => p.pane_id === x.pane_id));
          if (unknown) { reply({ error: { code: 'pane_not_found', message: `pane ${unknown.pane_id} not found` } }); break; }
          reply({ result: { type: 'subscription_started' } });
          subscriber = c;
          break;
        }
        default:
          reply({ error: { code: 'unknown_method', message: req.method } });
      }
    }
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(sock, r));
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
  assert.deepStrictEqual(
    calls.map((c) => [c.method, c.params]),
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
  console.log('✓ create space/tab/worktree, start agent, rename, close');

  // 4. subscription: ack is swallowed, events delivered, close reported
  const events: any[] = [];
  const ended = new Promise<void>((resolve) => {
    client.subscribe(DEFAULT_SUBSCRIPTIONS, (e) => events.push(e), () => resolve());
  });
  await new Promise((r) => setTimeout(r, 50));
  subscriber!.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } }) + '\n');
  subscriber!.write(JSON.stringify({ event: 'workspace.focused', data: { workspace_id: 'w1' } }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  subscriber!.end();
  await ended;
  assert.strictEqual(events.length, 2);
  console.log('✓ event subscription (ack, events, close)');

  // 5. events_lost error ends subscription with error
  const err = await new Promise<Error | undefined>((resolve) => {
    client.subscribe(DEFAULT_SUBSCRIPTIONS, () => {}, resolve);
    setTimeout(() => subscriber!.write(JSON.stringify({ id: 'x', error: { code: 'events_lost', message: 'fell behind' } }) + '\n'), 50);
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

  // 6. no server -> rejects quickly
  const dead = new HerdrClient(() => sock + '.missing');
  await assert.rejects(dead.request('ping'));
  console.log('✓ unreachable server rejects');

  server.close();
  try { fs.unlinkSync(sock); } catch {}
  console.log('\nall tests passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
