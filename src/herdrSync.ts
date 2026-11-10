// Keeps the extension's view of Herdr current: reads session.snapshot, re-reads it on every event, polls as a
// safety net, and tracks the connection: connecting (startup) / connected → a request fails → reconnecting
// (the last view stays, greyed, for a few seconds: Herdr updates hand off live) → down (diagnosed, retried with
// backoff, and at once when the socket file appears). No vscode imports: tested against a mock server
// (test/syncTest.ts).
import * as fs from 'fs';
import * as path from 'path';
import { backoffDelay, Diagnosis } from './connection';
import { errorText, HerdrClient, Subscription, subscriptionsFor } from './herdrClient';
import type { SessionSnapshotResult } from './herdrTypes';
import { allPanes, Model, normalize } from './model';

/** The extension's view of the Herdr server. */
export type Conn =
  | { kind: 'connecting' }
  | { kind: 'connected'; protocol?: number; version?: string }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'starting' }
  | ({ kind: 'down' } & Diagnosis);

export interface SyncTiming {
  /** How long a lost connection shows as "reconnecting" before it's diagnosed. */
  graceMs: number;
  /** While down, `herdr status` (diagnose) runs at most this often. */
  diagnoseEveryMs: number;
  /** Poll interval with a live event stream (Herdr sends no event for pane renames, so they arrive this way). */
  eventsPollMs: number;
  /** Poll interval without one. */
  pollMs: number;
  reconnectingPollMs: number;
  /** Events come in bursts: one snapshot for those this close together. */
  debounceMs: number;
  /** Poll interval while down, after this many failures in a row. */
  backoff(failures: number): number;
}

const TIMING: SyncTiming = {
  graceMs: 4000,
  diagnoseEveryMs: 10_000,
  eventsPollMs: 5000,
  pollMs: 1500,
  reconnectingPollMs: 1000,
  debounceMs: 120,
  backoff: backoffDelay,
};

export interface SyncDeps {
  client: Pick<HerdrClient, 'request' | 'subscribe'>;
  socketPath(): string;
  /** Why Herdr can't be reached (connection.ts diagnose()). */
  diagnose(error: unknown): Promise<Diagnosis>;
  /** A new snapshot was read. */
  onSnapshot(next: Model): void;
  /** Connected after not being connected (startup, or back after an outage). */
  onConnected(): void;
  /** The connection was just lost (still "reconnecting": the last snapshot is still what's shown). */
  onLost(): void;
  /** Herdr is down (diagnosed). `afterLoss`: it was connected before, rather than never reachable. */
  onDown(afterLoss: boolean): void;
  /** The connection state changed (redraw what shows it). */
  onChange(): void;
  log(line: string): void;
  timing?: Partial<SyncTiming>;
}

export class HerdrSync {
  conn: Conn = { kind: 'connecting' };
  /** An event stream is live (else the poll is fast). */
  eventsLive = false;
  private t: SyncTiming;
  private failures = 0;
  private lastDiagnosis = 0;
  /** The refresh running now; a refresh asked for meanwhile runs again in it and waits for the same promise. */
  private inFlight: Promise<void> | undefined;
  private again = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private socketWatch: fs.FSWatcher | undefined;
  private sub: Subscription | undefined;
  /** The panes of the last snapshot: agent status events are per pane, so the subscription follows them. */
  private panes: string[] = [];
  private subscribedPanes = '';
  private disposed = false;

  constructor(private deps: SyncDeps) {
    this.t = { ...TIMING, ...deps.timing };
  }

  get connected() {
    return this.conn.kind === 'connected';
  }

  /** The first snapshot, then events and polling. */
  async start() {
    await this.refresh();
    this.startEvents();
    this.schedulePoll();
  }

  /** Read the snapshot now. Resolves when it (and any refresh asked for meanwhile) is done. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.refreshLoop().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Try right now (Retry, window focus, sidebar shown, socket appeared, Herdr started). */
  async kick() {
    clearTimeout(this.pollTimer);
    this.lastDiagnosis = 0;
    await this.refresh();
    this.startEvents();
    this.schedulePoll();
  }

  /** Something changed in Herdr: re-read the snapshot soon (events are only invalidation signals). */
  scheduleRefresh() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), this.t.debounceMs);
  }

  /** Herdr is being started (startServer): failures until it answers don't count. Returns the state to restore. */
  beginStarting(): Conn {
    const prev = this.conn;
    this.conn = { kind: 'starting' };
    this.deps.onChange();
    return prev;
  }
  endStarting(prev: Conn) {
    this.conn = prev.kind === 'starting' ? { kind: 'connecting' } : prev;
    this.deps.onChange();
  }

  /** The socket path changed (another session): drop the old session's events and watch, connect now. */
  socketChanged() {
    this.stopWatchingSocket();
    this.sub?.dispose();
    this.sub = undefined;
    this.eventsLive = false;
    return this.kick();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.debounce);
    this.stopWatchingSocket();
    this.sub?.dispose();
    this.sub = undefined;
  }

  private async refreshLoop() {
    try {
      do {
        this.again = false;
        const res = await this.deps.client.request<SessionSnapshotResult>('session.snapshot');
        if (this.disposed) {
          return;
        }
        const next = normalize(res);
        const wasConnected = this.connected;
        this.conn = { kind: 'connected', protocol: res.snapshot.protocol, version: res.snapshot.version };
        this.failures = 0;
        this.panes = allPanes(next).map(({ pane }) => pane.id);
        this.deps.onSnapshot(next);
        if (!wasConnected) {
          this.deps.log(`connected to herdr ${this.conn.version ?? ''}`.trim());
          this.stopWatchingSocket();
          this.deps.onConnected();
        }
        // Panes came or went: move the live subscription to the new set. (Only a live one: restarting a
        // failed stream is the poll's job, so a stream that keeps failing can't loop through here.)
        if (this.sub && this.paneKey() !== this.subscribedPanes) {
          this.startEvents();
        }
      } while (this.again);
    } catch (e) {
      if (!this.disposed) {
        await this.onFailure(e);
      }
    }
  }

  private async onFailure(e: unknown) {
    this.failures++;
    const now = Date.now();
    const conn = this.conn;
    if (conn.kind === 'connected') {
      this.deps.log(`lost herdr: ${errorText(e)}`);
      this.deps.onLost();
      this.conn = { kind: 'reconnecting', since: now };
      this.deps.onChange();
      return;
    }
    if (conn.kind === 'starting') {
      return; // startServer owns the state until it's done
    }
    if (conn.kind === 'reconnecting' && now - conn.since < this.t.graceMs) {
      return;
    }
    const afterLoss = conn.kind === 'reconnecting';
    // Diagnosing runs `herdr status`; while it stays down, do that at most every diagnoseEveryMs.
    if (conn.kind === 'down' && now - this.lastDiagnosis < this.t.diagnoseEveryMs) {
      return;
    }
    this.lastDiagnosis = now;
    const before = conn.kind === 'down' ? conn.reason : undefined;
    this.panes = [];
    const why = await this.deps.diagnose(e);
    this.conn = { kind: 'down', ...why };
    if (why.reason !== before) {
      this.deps.log(`herdr unavailable: ${why.reason}${why.detail ? ` (${why.detail})` : ''}`);
    }
    this.deps.onDown(afterLoss);
    this.deps.onChange();
    this.watchSocket();
  }

  private schedulePoll() {
    if (this.disposed) {
      return;
    }
    clearTimeout(this.pollTimer);
    let delay = this.t.backoff(this.failures);
    if (this.connected) {
      delay = this.eventsLive ? this.t.eventsPollMs : this.t.pollMs;
    } else if (this.conn.kind === 'reconnecting') {
      delay = this.t.reconnectingPollMs;
    }
    this.pollTimer = setTimeout(async () => {
      await this.refresh();
      this.startEvents();
      this.schedulePoll();
    }, delay);
  }

  private paneKey() {
    return [...this.panes].sort().join(' ');
  }

  private startEvents() {
    const key = this.paneKey();
    if (this.sub && key !== this.subscribedPanes) {
      this.sub.dispose(); // dispose() doesn't call onEnd: no "ended" log, no fast polling
      this.sub = undefined;
    }
    if (this.sub || !this.connected || this.disposed) {
      return;
    }
    this.subscribedPanes = key;
    const self: Subscription = this.deps.client.subscribe(
      subscriptionsFor(this.panes),
      () => this.scheduleRefresh(),
      (err) => {
        if (this.sub !== self) {
          return;
        }
        this.sub = undefined;
        if (this.eventsLive || err) {
          this.deps.log(`event stream ended${err ? `: ${err.message}` : ''}; polling`);
        }
        this.eventsLive = false;
        this.scheduleRefresh(); // events_lost or reconnect => re-read authoritative state
        this.schedulePoll(); // poll fast again until the stream is back
      },
    );
    this.sub = self;
    this.eventsLive = true;
  }

  // While Herdr is down, reconnect the moment its socket appears.
  private watchSocket() {
    if (this.socketWatch || this.disposed) {
      return;
    }
    try {
      this.socketWatch = fs.watch(path.dirname(this.deps.socketPath()), () => {
        if (!this.connected && !this.inFlight && fs.existsSync(this.deps.socketPath())) {
          void this.kick();
        }
      });
    } catch {
      // The folder doesn't exist yet: backoff polling covers it.
    }
  }

  private stopWatchingSocket() {
    this.socketWatch?.close();
    this.socketWatch = undefined;
  }
}
