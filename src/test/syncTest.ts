// HerdrSync (src/herdrSync.ts) against a fake Herdr server that can stop and start again: connect, lose the
// connection, the reconnect grace, diagnose, come back, refreshes that wait for each other, and the event
// subscription following the pane set. No VS Code needed.
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';
import { HerdrClient } from '../herdrClient';
import { HerdrSync } from '../herdrSync';
import type { Model } from '../model';
import type { PaneInfo, SessionSnapshotResult, TabInfo, WorkspaceInfo } from '../herdrTypes';

const sock = path.join(os.tmpdir(), `herdr-sync-${process.pid}.sock`);
try {
  fs.unlinkSync(sock);
} catch {}

const ws = (workspace_id: string): WorkspaceInfo => ({
  workspace_id, label: workspace_id, number: 1, focused: true, pane_count: 1, tab_count: 1, active_tab_id: `${workspace_id}:t1`, agent_status: 'unknown',
});
const tab = (tab_id: string): TabInfo => ({ tab_id, workspace_id: tab_id.split(':')[0], label: '1', number: 1, focused: true, pane_count: 1, agent_status: 'unknown' });
const pane = (pane_id: string): PaneInfo => ({
  pane_id, tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: `term_${pane_id}`, focused: false, agent_status: 'unknown', revision: 1,
});
let paneIds = ['w1:p1'];
const snapshot = (): SessionSnapshotResult => ({
  type: 'session_snapshot',
  snapshot: { version: '0.9.5', protocol: 22, workspaces: [ws('w1')], tabs: [tab('w1:t1')], panes: paneIds.map(pane), layouts: [], agents: [] } as any,
});

let snapshots = 0;
/** Each events.subscribe: the panes it asked for. */
const subscribed: string[][] = [];
let server: net.Server | undefined;
const sockets = new Set<net.Socket>();
function startServer() {
  return new Promise<void>((resolve) => {
    server = net.createServer((c) => {
      sockets.add(c);
      c.on('close', () => sockets.delete(c));
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const req = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          const reply = (o: any) => c.write(JSON.stringify({ id: req.id, ...o }) + '\n');
          if (req.method === 'session.snapshot') {
            snapshots++;
            // a little slow, so refreshes overlap
            setTimeout(() => reply({ result: snapshot() }), 30);
          } else if (req.method === 'events.subscribe') {
            subscribed.push(req.params.subscriptions.filter((x: any) => x.pane_id).map((x: any) => x.pane_id));
            reply({ result: { type: 'subscription_started' } });
          }
        }
      });
    });
    server.listen(sock, resolve);
  });
}
function stopServer() {
  return new Promise<void>((resolve) => {
    for (const c of sockets) c.destroy();
    server!.close(() => resolve());
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

async function main() {
  await startServer();
  const seen: string[] = [];
  let model: Model | undefined;
  let diagnosed = 0;
  const sync = new HerdrSync({
    client: new HerdrClient(() => sock),
    socketPath: () => sock,
    diagnose: async () => {
      diagnosed++;
      return { reason: 'not-running', socket: sock, customSocket: false, binary: 'herdr' };
    },
    onSnapshot: (m) => (model = m),
    onConnected: () => seen.push('connected'),
    onLost: () => seen.push('lost'),
    onDown: (afterLoss) => seen.push(`down${afterLoss ? ' after loss' : ''}`),
    onChange: () => {},
    log: () => {},
    // fast, so the test doesn't wait on real-life intervals
    timing: { graceMs: 150, diagnoseEveryMs: 10_000, eventsPollMs: 60_000, pollMs: 60_000, reconnectingPollMs: 50, debounceMs: 10, backoff: () => 50 },
  });

  // A function, so TypeScript doesn't narrow the state across the asserts below.
  const state = (): string => sync.conn.kind;

  // 1. start: connected, one snapshot, events subscribed for the snapshot's panes
  await sync.start();
  assert.strictEqual(state(), 'connected');
  assert.deepStrictEqual(seen, ['connected']);
  assert.strictEqual(model?.spaces[0].id, 'w1');
  assert.ok(sync.eventsLive);
  await until('subscribed', () => subscribed.length === 1);
  assert.deepStrictEqual(subscribed, [['w1:p1']]);
  console.log('✓ connects, reads the snapshot, subscribes per pane');

  // 2. refreshes asked for while one runs share it, and resolve only once the state is current
  const before = snapshots;
  const a = sync.refresh();
  const b = sync.refresh();
  assert.strictEqual(a, b, 'a refresh asked for meanwhile waits on the running one');
  await a;
  assert.strictEqual(snapshots - before, 2, 'it runs once more for the refresh asked for meanwhile');
  console.log('✓ overlapping refreshes wait for each other');

  // 3. the pane set changes: the subscription moves to the new panes
  paneIds = ['w1:p1', 'w1:p2'];
  await sync.kick();
  await until('resubscribed', () => subscribed.length === 2);
  assert.deepStrictEqual(subscribed[1], ['w1:p1', 'w1:p2']);
  console.log('✓ the subscription follows the pane set');

  // 4. Herdr goes away: reconnecting (last view kept) for the grace, then diagnosed down, once
  await stopServer();
  await sync.refresh();
  assert.strictEqual(state(), 'reconnecting');
  assert.ok(model, 'the last snapshot is still shown while reconnecting');
  await sync.refresh();
  assert.strictEqual(state(), 'reconnecting', 'still within the grace');
  await sleep(200);
  await sync.refresh();
  assert.strictEqual(state(), 'down');
  assert.deepStrictEqual(seen, ['connected', 'lost', 'down after loss']);
  await sync.refresh();
  assert.strictEqual(diagnosed, 1, 'while down, diagnose runs at most every diagnoseEveryMs');
  console.log('✓ lost → reconnecting (grace) → down, diagnosed once');

  // 5. Herdr is back: kick connects again (the bug: a kick during a running refresh returned before it)
  await startServer();
  const running = sync.refresh();
  await sync.kick();
  assert.strictEqual(state(), 'connected', 'kick resolves once connected, even with a refresh running');
  await running;
  assert.deepStrictEqual(seen, ['connected', 'lost', 'down after loss', 'connected']);
  console.log('✓ back after an outage');

  // 6. starting Herdr: failures meanwhile don't change the state; it's restored after
  const prev = sync.beginStarting();
  assert.strictEqual(state(), 'starting');
  sync.endStarting(prev);
  assert.strictEqual(state(), 'connected');
  console.log('✓ starting state');

  sync.dispose();
  await stopServer();
  console.log('\nsync tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
