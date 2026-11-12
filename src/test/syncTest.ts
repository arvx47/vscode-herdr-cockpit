// HerdrSync (src/herdrSync.ts) against the fake Herdr server (mockHerdr.ts), which can stop and start again:
// connect, lose the connection, the reconnect grace, diagnose, come back, refreshes that wait for each other,
// a kick or the socket appearing while a refresh fails, the event subscription following the pane set (and
// recovering from pane_not_found), events causing one debounced refresh, switching sockets, and dispose.
// No VS Code needed.
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';
import { HerdrClient } from '../herdrClient';
import { HerdrSync, SyncDeps } from '../herdrSync';
import type { Model } from '../model';
import type { SessionSnapshotResult } from '../herdrTypes';
import { MockHerdr, pane, sleep, snap, tab, until, ws } from './mockHerdr';

// Its own folder: the sync watches the socket's folder while Herdr is down.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sync-'));
const sock = path.join(dir, 'herdr.sock');
const sock2 = path.join(dir, 'other.sock');

let paneIds = ['w1:p1'];
const snapshot = (): SessionSnapshotResult =>
  snap({ workspaces: [ws('w1', 'w1', { focused: true })], tabs: [tab('w1:t1')], panes: paneIds.map((id) => pane(id, 'w1:t1')) });

let snapshots = 0;
/** Runs once right after the next snapshot is answered (to change the session between snapshot and subscribe). */
let afterSnapshot: (() => void) | undefined;
const mock = new MockHerdr({
  socket: sock,
  snapshot,
  handlers: {
    'session.snapshot': (_req, reply) => {
      snapshots++;
      // a little slow, so refreshes overlap
      setTimeout(() => {
        reply({ result: snapshot() });
        const after = afterSnapshot;
        afterSnapshot = undefined;
        after?.();
      }, 30);
    },
  },
});
/** Another session, on another socket. */
const other = new MockHerdr({
  socket: sock2,
  snapshot: () => snap({ workspaces: [ws('w2')], tabs: [tab('w2:t1')], panes: [pane('w2:p1')] }),
});

/** A gate that diagnose() waits on while it's closed. */
let gate: Promise<void> | undefined;
let openGate = () => {};
const closeGate = () => {
  gate = new Promise<void>((r) => (openGate = r));
};

function makeSync(name: string, timing: SyncDeps['timing'], socketPath = () => sock) {
  const seen: string[] = [];
  const state = { model: undefined as Model | undefined, diagnosed: 0, seen };
  const sync = new HerdrSync({
    client: new HerdrClient(socketPath),
    socketPath,
    diagnose: async () => {
      state.diagnosed++;
      await gate;
      return { reason: 'not-running', socket: socketPath(), customSocket: false, binary: 'herdr' };
    },
    onSnapshot: (m) => (state.model = m),
    onConnected: () => seen.push('connected'),
    onLost: () => seen.push('lost'),
    onDown: (afterLoss) => seen.push(`down${afterLoss ? ' after loss' : ''}`),
    onChange: () => {},
    log: (line) => {
      if (process.env.HB_SYNC_LOG) {
        console.log(`  [${name}] ${line}`);
      }
    },
    timing,
  });
  return { sync, state };
}

async function main() {
  await mock.start();
  // fast, so the test doesn't wait on real-life intervals
  const { sync, state: s } = makeSync('main', {
    graceMs: 150, diagnoseEveryMs: 10_000, eventsPollMs: 60_000, pollMs: 60_000, reconnectingPollMs: 50, debounceMs: 10, backoff: () => 50,
  });
  const seen = s.seen;

  // A function, so TypeScript doesn't narrow the state across the asserts below.
  const state = (x: HerdrSync = sync): string => x.conn.kind;

  // 1. start: connected, one snapshot, events subscribed for the snapshot's panes; live once Herdr acknowledged
  await sync.start();
  assert.strictEqual(state(), 'connected');
  assert.deepStrictEqual(seen, ['connected']);
  assert.strictEqual(s.model?.spaces[0].id, 'w1');
  await until('subscribed', () => mock.subscribed.length === 1);
  await until('events live (acknowledged)', () => sync.eventsLive);
  assert.deepStrictEqual(mock.subscribed, [['w1:p1']]);
  console.log('✓ connects, reads the snapshot, subscribes per pane, live on the ack');

  // 2. refreshes asked for while one runs share it, and resolve only once the state is current
  let before = snapshots;
  const a = sync.refresh();
  const b = sync.refresh();
  assert.strictEqual(a, b, 'a refresh asked for meanwhile waits on the running one');
  await a;
  assert.strictEqual(snapshots - before, 2, 'it runs once more for the refresh asked for meanwhile');
  console.log('✓ overlapping refreshes wait for each other');

  // 3. the pane set changes: the subscription moves to the new panes
  paneIds = ['w1:p1', 'w1:p2'];
  await sync.kick();
  await until('resubscribed', () => mock.subscribed.length === 2);
  assert.deepStrictEqual(mock.subscribed[1], ['w1:p1', 'w1:p2']);
  console.log('✓ the subscription follows the pane set');

  // 3b. events are invalidation signals: a burst of them causes one (debounced) snapshot
  await until('live', () => sync.eventsLive);
  before = snapshots;
  for (let i = 0; i < 3; i++) {
    mock.push({ event: 'workspace.focused', data: { workspace_id: 'w1' } });
  }
  await until('refreshed after the events', () => snapshots > before);
  await sleep(100);
  assert.strictEqual(snapshots - before, 1, 'one snapshot for the burst');
  console.log('✓ events cause one debounced refresh');

  // 4. Herdr goes away: reconnecting (last view kept) for the grace, then diagnosed down, once
  await mock.stop();
  await sync.refresh();
  assert.strictEqual(state(), 'reconnecting');
  assert.ok(s.model, 'the last snapshot is still shown while reconnecting');
  await sync.refresh();
  assert.strictEqual(state(), 'reconnecting', 'still within the grace');
  await sleep(200);
  await sync.refresh();
  assert.strictEqual(state(), 'down');
  assert.deepStrictEqual(seen, ['connected', 'lost', 'down after loss']);
  await sync.refresh();
  assert.strictEqual(s.diagnosed, 1, 'while down, diagnose runs at most every diagnoseEveryMs');
  console.log('✓ lost → reconnecting (grace) → down, diagnosed once');

  // 5. Herdr is back: kick connects again (the bug: a kick during a running refresh returned before it)
  await mock.start();
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

  // 7. starting from down: a connection made while starting is kept (it used to be reset to down, then connected twice)
  await mock.stop();
  await sync.refresh();
  await sleep(200);
  await sync.refresh();
  assert.strictEqual(state(), 'down');
  const connectedBefore = seen.filter((x) => x === 'connected').length;
  const prevDown = sync.beginStarting();
  await mock.start();
  await sync.refresh();
  assert.strictEqual(state(), 'connected', 'connects while starting');
  sync.endStarting(prevDown);
  assert.strictEqual(state(), 'connected', 'still connected after starting ends');
  await sync.refresh();
  assert.strictEqual(seen.filter((x) => x === 'connected').length, connectedBefore + 1, 'connected once');
  console.log('✓ a connection made while starting is kept');

  // 8. a kick while a refresh is failing (diagnosing) tries again when that refresh ends, instead of
  // resolving with the stale "down" and waiting for the backoff. (No start(): no poll, so only the kick can.)
  const slow = { graceMs: 0, diagnoseEveryMs: 0, eventsPollMs: 60_000, pollMs: 60_000, reconnectingPollMs: 60_000, debounceMs: 10, backoff: () => 60_000 };
  await mock.stop();
  fs.rmSync(sock, { force: true });
  const k = makeSync('kick', slow);
  await k.sync.refresh();
  assert.strictEqual(state(k.sync), 'down');
  closeGate();
  const failing = k.sync.refresh();
  await until('diagnosing', () => k.state.diagnosed === 2);
  await mock.start();
  const kicked = k.sync.kick();
  openGate();
  await kicked;
  assert.strictEqual(state(k.sync), 'connected', 'the kick made during the failing refresh connected');
  await failing;
  k.sync.dispose();
  console.log('✓ a kick during a failing refresh retries');

  // 9. the socket appearing while a refresh is failing (diagnose can take seconds) reconnects at once too
  await mock.stop();
  fs.rmSync(sock, { force: true });
  const w = makeSync('watch', slow);
  await w.sync.refresh(); // down: now watching the socket's folder
  assert.strictEqual(state(w.sync), 'down');
  closeGate();
  const failing2 = w.sync.refresh();
  await until('diagnosing', () => w.state.diagnosed === 2);
  const snapshotsBefore = snapshots;
  await mock.start(); // the socket file appears: the watcher kicks while the refresh is still diagnosing
  await sleep(100);
  openGate();
  await failing2;
  await until('connected via the socket watcher', () => state(w.sync) === 'connected');
  assert.ok(snapshots > snapshotsBefore);
  w.sync.dispose();
  gate = undefined;
  console.log('✓ the socket appearing during a failing refresh reconnects without waiting for the backoff');

  // 10. a subscription Herdr refuses (pane_not_found: a pane closed between snapshot and subscribe) isn't
  // live; the poll re-reads and subscribes with the current panes.
  await sync.kick();
  const r = makeSync('resub', { graceMs: 150, diagnoseEveryMs: 10_000, eventsPollMs: 60_000, pollMs: 100, reconnectingPollMs: 50, debounceMs: 10, backoff: () => 50 });
  paneIds = ['w1:p1', 'w1:p2'];
  await r.sync.start();
  await until('resub live', () => r.sync.eventsLive);
  const subsBefore = mock.subscribed.length;
  paneIds = ['w1:p1', 'w1:p2', 'w1:p3'];
  afterSnapshot = () => (paneIds = ['w1:p1', 'w1:p2']); // p3 closes right after the snapshot that has it
  await r.sync.kick();
  await until('refused subscription', () => mock.subscribed.slice(subsBefore).some((x) => x.includes('w1:p3')));
  await until('resubscribed without the closed pane', () => {
    const last = mock.subscribed[mock.subscribed.length - 1];
    return r.sync.eventsLive && last.join() === 'w1:p1,w1:p2';
  });
  r.sync.dispose();
  console.log('✓ pane_not_found: not live, then resubscribed with the current panes');

  // 11. socketChanged: the old session's stream is dropped, the new socket is read and subscribed
  await other.start();
  let current = sock;
  const c = makeSync('switch', { graceMs: 150, diagnoseEveryMs: 10_000, eventsPollMs: 60_000, pollMs: 60_000, reconnectingPollMs: 50, debounceMs: 10, backoff: () => 50 }, () => current);
  await c.sync.start();
  await until('first session live', () => c.sync.eventsLive);
  const liveOnFirst = mock.subscribers.size;
  current = sock2;
  await c.sync.socketChanged();
  assert.strictEqual(c.state.model?.spaces[0].id, 'w2', 'reads the new session');
  await until('subscribed to the new session', () => other.subscribers.size === 1 && c.sync.eventsLive);
  await until('old stream dropped', () => mock.subscribers.size === liveOnFirst - 1);
  c.sync.dispose();
  await other.stop();
  console.log('✓ socketChanged drops the old stream and connects to the new socket');

  // 12. dispose: the stream closes, events and timers no longer refresh
  await until('main live', () => sync.eventsLive);
  sync.dispose();
  await until('stream closed', () => mock.subscribers.size === 0);
  before = snapshots;
  mock.push({ event: 'workspace.focused', data: { workspace_id: 'w1' } });
  await sleep(150);
  assert.strictEqual(snapshots, before, 'nothing refreshes after dispose');
  console.log('✓ dispose stops the stream and the timers');

  await mock.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nsync tests passed');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
