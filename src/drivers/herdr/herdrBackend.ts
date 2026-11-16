// The Herdr driver: the Herdr server, over its socket (herdrClient.ts). No vscode imports.

import type { Backend, BackendCapabilities, BackendSnapshot, PaneReadSource, Subscription } from '../backend';
import { HerdrClient, subscriptionsFor } from './herdrClient';
import { HerdrActions } from './herdrActions';
import type { PaneProcessInfo, PaneProcessInfoResult, PaneReadResponse, SessionSnapshotResult } from './herdrTypes';
import { normalize } from '../../state/model';

type Client = Pick<HerdrClient, 'request' | 'subscribe'>;

/** The Herdr server, over its socket. */
export class HerdrBackend implements Backend {
  readonly id = 'herdr';
  readonly capabilities: BackendCapabilities = { label: 'Herdr', server: true, worktrees: true };
  readonly actions: HerdrActions;

  constructor(private client: Client) {
    this.actions = new HerdrActions(client);
  }

  async snapshot(): Promise<BackendSnapshot> {
    const res = await this.client.request<SessionSnapshotResult>('session.snapshot');
    return { model: normalize(res), version: res.snapshot.version, protocol: res.snapshot.protocol };
  }

  rawSnapshot(): Promise<unknown> {
    return this.client.request('session.snapshot');
  }

  subscribe(paneIds: readonly string[], onEvent: () => void, onEnd: (err?: Error) => void, opts?: { onAck?: () => void }): Subscription {
    return this.client.subscribe(subscriptionsFor(paneIds), () => onEvent(), onEnd, opts);
  }

  async focusSpace(spaceId: string): Promise<void> {
    await this.client.request('workspace.focus', { workspace_id: spaceId });
  }

  async focusAgent(paneId: string): Promise<void> {
    await this.client.request('agent.focus', { target: paneId });
  }

  async processInfo(paneId: string): Promise<PaneProcessInfo> {
    const r = await this.client.request<PaneProcessInfoResult>('pane.process_info', { pane_id: paneId });
    return r.process_info;
  }

  async readText(paneId: string, source: PaneReadSource, lines: number): Promise<string> {
    const r = await this.client.request<PaneReadResponse>('pane.read', { pane_id: paneId, source, lines });
    return r.read.text;
  }
}
