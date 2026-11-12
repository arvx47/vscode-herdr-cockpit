// A fake Herdr socket server for the tests (mockTest.ts, syncTest.ts). It answers like herdr 0.9.x where we
// know how: NDJSON over a Unix socket, per-method parameter checks for the rules Herdr enforces, and
// events.subscribe rejecting pane-scoped events without a pane_id and unknown pane ids. It can stop and start
// again on the same socket. Tests override or add methods with `handlers`.
import * as fs from 'fs';
import * as net from 'net';
import type { PaneInfo, SessionSnapshotResult, TabInfo, WorkspaceInfo } from '../herdrTypes';

export interface MockRequest {
  id: string;
  method: string;
  params: any;
}
export interface MockError {
  code: string;
  message: string;
}
export type Reply = (o: { result: unknown } | { error: MockError }) => void;
/** Handles one request: call `reply` (now or later). */
export type Handler = (req: MockRequest, reply: Reply, conn: net.Socket) => void;

// Synthetic records typed against the generated schema, so a schema change breaks the build here.
export const ws = (workspace_id: string, label = workspace_id, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id, label, number: 1, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${workspace_id}:t1`, agent_status: 'unknown', ...extra,
});
export const tab = (tab_id: string, label = '1'): TabInfo => ({
  tab_id, workspace_id: tab_id.split(':')[0], label, number: 1, focused: false, pane_count: 1, agent_status: 'unknown',
});
export const pane = (pane_id: string, tab_id = `${pane_id.split(':')[0]}:t1`, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id, tab_id, workspace_id: pane_id.split(':')[0], terminal_id: `term_${pane_id}`, focused: false, agent_status: 'unknown', revision: 1, ...extra,
});
export const snap = (s: Partial<SessionSnapshotResult['snapshot']>): SessionSnapshotResult => ({
  type: 'session_snapshot',
  snapshot: { version: '0.9.5', protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [], ...s },
});

/** Herdr's rule for agent names (they double as CLI targets). */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** Events that need a pane_id (verified on herdr 0.9.1). */
const PANE_SCOPED = ['pane.agent_status_changed', 'pane.output_matched', 'pane.scroll_changed'];

const invalid = (message: string): MockError => ({ code: 'invalid_request', message: `invalid request: ${message}` });
const isText = (v: unknown) => typeof v === 'string';
const given = (v: unknown) => v !== undefined && v !== null;

/** Required string fields per method, as in the generated param types (src/herdrTypes.ts). */
const REQUIRED: Record<string, string[]> = {
  'workspace.focus': ['workspace_id'],
  'workspace.rename': ['workspace_id', 'label'],
  'workspace.close': ['workspace_id'],
  'worktree.remove': ['workspace_id'],
  'tab.rename': ['tab_id', 'label'],
  'tab.close': ['tab_id'],
  'agent.start': ['pane_id', 'kind', 'name'],
  'agent.prompt': ['target', 'text'],
  'agent.rename': ['target'],
  'pane.rename': ['pane_id'],
  'pane.close': ['pane_id'],
  'pane.split': ['direction'],
  'pane.read': ['pane_id', 'source'],
  'pane.process_info': ['pane_id'],
};

/**
 * What Herdr would refuse in these params, or undefined. Only rules we know Herdr enforces (its messages where
 * we have them); anything else is accepted.
 */
export function validate(method: string, params: any): MockError | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return invalid('params must be an object');
  }
  for (const field of REQUIRED[method] ?? []) {
    if (!isText(params[field])) {
      return invalid(`missing field \`${field}\``);
    }
  }
  switch (method) {
    case 'worktree.create': {
      if (given(params.workspace_id) && given(params.cwd)) {
        return invalid('only one of workspace_id or cwd may be supplied');
      }
      if (given(params.path) === given(params.branch)) {
        return invalid('exactly one of path or branch is required');
      }
      return undefined;
    }
    case 'agent.start': {
      if (!AGENT_NAME.test(params.name)) {
        return invalid(`agent name "${params.name}" must match ${AGENT_NAME.source}`);
      }
      const t = params.timeout_ms;
      if (given(t) && !(typeof t === 'number' && t > 3000 && t <= 300_000)) {
        return invalid('timeout_ms must be greater than 3000 and at most 300000');
      }
      if (given(params.args) && !(Array.isArray(params.args) && params.args.every(isText))) {
        return invalid('args must be a list of strings');
      }
      return undefined;
    }
    case 'agent.prompt':
      if (!params.text.trim()) {
        return { code: 'empty_agent_prompt', message: 'agent prompt text is empty' };
      }
      return undefined;
    case 'agent.rename':
      if (given(params.name) && !(isText(params.name) && AGENT_NAME.test(params.name))) {
        return invalid(`agent name "${params.name}" must match ${AGENT_NAME.source}`);
      }
      return undefined;
    case 'pane.rename':
      if (given(params.label) && !isText(params.label)) {
        return invalid('label must be a string or null');
      }
      return undefined;
    case 'pane.split':
      if (!['right', 'down'].includes(params.direction)) {
        return invalid(`unknown direction "${params.direction}"`);
      }
      return undefined;
    case 'events.subscribe': {
      if (!Array.isArray(params.subscriptions)) {
        return invalid('missing field `subscriptions`');
      }
      const bad = params.subscriptions.find((x: any) => PANE_SCOPED.includes(x?.type) && !x.pane_id);
      if (bad) {
        return invalid('missing field `pane_id`');
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export interface MockHerdrOptions {
  socket: string;
  /** The session as it is now (read on every request). */
  snapshot: () => SessionSnapshotResult;
  /** Extra methods, or replacements for the defaults. */
  handlers?: Record<string, Handler>;
}

export class MockHerdr {
  /** Every request that passed validation, in order (session.snapshot and events.subscribe included). */
  readonly requests: MockRequest[] = [];
  /** Each events.subscribe Herdr accepted or refused: the pane ids it asked for. */
  readonly subscribed: string[][] = [];
  /** Connections with a live (accepted) events.subscribe. */
  readonly subscribers = new Set<net.Socket>();
  /** Requests refused by validate(), with why. */
  readonly refused: { req: MockRequest; error: MockError }[] = [];
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();
  private handlers: Record<string, Handler>;

  constructor(private opts: MockHerdrOptions) {
    this.handlers = { ...this.defaults(), ...opts.handlers };
  }

  /** Requests for one method, in order. */
  calls(method: string) {
    return this.requests.filter((r) => r.method === method);
  }

  start() {
    try {
      fs.unlinkSync(this.opts.socket);
    } catch {
      // not there
    }
    return new Promise<void>((resolve) => {
      this.server = net.createServer((c) => this.accept(c));
      this.server.listen(this.opts.socket, resolve);
    });
  }

  /** Closes every connection (live subscriptions end) and stops listening. */
  stop() {
    return new Promise<void>((resolve) => {
      for (const c of this.sockets) {
        c.destroy();
      }
      this.subscribers.clear();
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  /** Sends one line to every live subscriber. */
  push(line: object) {
    for (const c of this.subscribers) {
      c.write(JSON.stringify(line) + '\n');
    }
  }

  private accept(c: net.Socket) {
    this.sockets.add(c);
    c.on('close', () => {
      this.sockets.delete(c);
      this.subscribers.delete(c);
    });
    c.on('error', () => {});
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as MockRequest;
        buf = buf.slice(nl + 1);
        this.handle(req, c);
      }
    });
  }

  private handle(req: MockRequest, c: net.Socket) {
    const reply: Reply = (o) => {
      if (!c.destroyed) {
        c.write(JSON.stringify({ id: req.id, ...o }) + '\n');
      }
    };
    if (req.method === 'events.subscribe' && Array.isArray(req.params?.subscriptions)) {
      this.subscribed.push(req.params.subscriptions.filter((x: any) => x.pane_id).map((x: any) => x.pane_id));
    }
    const error = validate(req.method, req.params);
    if (error) {
      this.refused.push({ req, error });
      reply({ error });
      return;
    }
    this.requests.push(req);
    const h = this.handlers[req.method];
    if (!h) {
      reply({ error: { code: 'unknown_method', message: req.method } });
      return;
    }
    h(req, reply, c);
  }

  private defaults(): Record<string, Handler> {
    const panes = () => this.opts.snapshot().snapshot.panes;
    const hasPane = (id: string) => panes().some((p) => p.pane_id === id);
    const notFound = (id: string): MockError => ({ code: 'pane_not_found', message: `pane ${id} not found` });
    const ok: Handler = (_req, reply) => reply({ result: { type: 'ok' } });
    const paneOp: Handler = (req, reply) => {
      const id = req.params.pane_id ?? req.params.target;
      if (!hasPane(id)) {
        reply({ error: notFound(id) });
        return;
      }
      reply({ result: { type: 'ok' } });
    };
    return {
      'session.snapshot': (_req, reply) => reply({ result: this.opts.snapshot() }),
      'events.subscribe': (req, reply, c) => {
        // Like herdr 0.9.1: one unknown pane id rejects the whole request.
        const unknown = req.params.subscriptions.find((x: any) => x.pane_id && !hasPane(x.pane_id));
        if (unknown) {
          reply({ error: notFound(unknown.pane_id) });
          return;
        }
        reply({ result: { type: 'subscription_started' } });
        this.subscribers.add(c);
      },
      'workspace.rename': ok,
      'workspace.close': ok,
      'tab.rename': ok,
      'tab.close': ok,
      'pane.rename': paneOp,
      'pane.close': paneOp,
      'agent.rename': paneOp,
      'pane.split': (req, reply) => {
        const target = req.params.target_pane_id;
        if (target && !hasPane(target)) {
          reply({ error: notFound(target) });
          return;
        }
        const tabId = panes().find((p) => p.pane_id === target)?.tab_id ?? 'w1:t1';
        const id = `${tabId.split(':')[0]}:p${panes().length + 10}`;
        reply({ result: { type: 'pane_info', pane: pane(id, tabId, { cwd: req.params.cwd ?? undefined }) } });
      },
    };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(what: string, ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await sleep(10);
  }
}
