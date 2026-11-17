// The driver layer: what the extension needs from whatever runs the panes and agents. Reading the session as a
// Model, hearing that it changed, creating/renaming/closing things, focusing, and reading what a pane shows.
// Drivers: Herdr (herdrBackend.ts, a client of the Herdr server); each also brings its own terminal tab
// (drivers.ts). The native driver (panes run by the extension itself) lives on the native-driver branch.
// No vscode imports.

import type {
  AgentInfo,
  PaneInfo,
  PaneProcessInfo,
  PaneSplitParams,
  TabCreateParams,
  TabInfo,
  WorkspaceCreateParams,
  WorkspaceInfo,
  WorktreeCreateParams,
  WorktreeListResult,
  WorktreeOpenedResult,
  WorktreeOpenParams,
  WorktreeInfo,
} from './herdr/herdrTypes';
import type { Model } from '../state/model';

/** Something to stop listening to. */
export interface Subscription {
  dispose(): void;
}

/** The drivers there are (herdr.driver). */
export const DRIVERS = ['herdr'] as const;
export type DriverId = (typeof DRIVERS)[number];

/** What a driver can do beyond the common ground; the extension hides or explains what it can't. */
export interface BackendCapabilities {
  /** Its name, where it matters ("Herdr"). */
  label: string;
  /**
   * A server that runs on its own, outliving the editor: started, diagnosed and reconnected to, with its TUI,
   * plugin and other clients (takeover, claims). Without one the session lives in this window and is always there.
   */
  server: boolean;
  /** New spaces on git worktrees (worktree.create / worktree.remove). */
  worktrees: boolean;
}

/** For messages: " in Herdr" for a driver whose server keeps the panes, nothing for one whose panes are this window's. */
export function inDriver(c: BackendCapabilities): string {
  if (c.server) {
    return ` in ${c.label}`;
  }
  return '';
}

/** A session read: the model, plus which server answered (shown at the bottom of the sidebar). */
export interface BackendSnapshot {
  model: Model;
  version?: string;
  protocol?: number;
}

/**
 * A new worktree space's params, as Herdr checks them: the repo comes from a space
 * (`workspace_id`) or a folder (`cwd`), not both, and exactly one of a new `branch` or an existing `path`.
 */
export type WorktreeCreate = Omit<WorktreeCreateParams, 'workspace_id' | 'cwd' | 'branch' | 'path'> &
  ({ workspace_id: string; cwd?: never } | { cwd: string; workspace_id?: never }) &
  ({ branch: string; path?: never } | { path: string; branch?: never });

/** Which repo a worktree call is about: a space's (`workspace_id`) or a folder's (`cwd`), not both. */
export type WorktreeSource = { workspace_id: string; cwd?: never } | { cwd: string; workspace_id?: never };

/** Opening an existing worktree (`path`) as a space; the source must be the repo's own space or folder. */
export type WorktreeOpen = Omit<WorktreeOpenParams, 'workspace_id' | 'cwd' | 'path'> & WorktreeSource & { path: string };

/** A new tab, or a new space's first tab. */
export interface Created {
  tab: TabInfo;
  /** The new tab's first pane. */
  pane: PaneInfo;
}

/**
 * Creating, renaming and closing spaces, tabs, panes and agents (HerdrActions for Herdr). Records come back in Herdr's shape (herdrTypes.ts), the shape every driver answers in.
 */
export interface BackendActions {
  /** New tab in a space: a fresh shell in `cwd`, or the space's folder. */
  createTab(params: TabCreateParams): Promise<Created>;
  /** New space rooted at `cwd`. */
  createSpace(params: WorkspaceCreateParams): Promise<Created & { workspace: WorkspaceInfo }>;
  /** New space on a new git worktree of a repo (needs capabilities.worktrees). */
  createWorktreeSpace(params: WorktreeCreate): Promise<Created & { workspace: WorkspaceInfo; worktree: WorktreeInfo }>;
  /** Every git worktree of a repo, with the space each is open in (needs capabilities.worktrees). */
  listWorktrees(params: WorktreeSource): Promise<WorktreeListResult>;
  /** A space on an existing worktree; answers its space when it already has one (`already_open`). */
  openWorktreeSpace(params: WorktreeOpen): Promise<WorktreeOpenedResult>;
  /** Close a worktree space and delete its folder; refused with uncommitted changes unless `force`. */
  removeWorktree(workspaceId: string, force?: boolean): Promise<unknown>;
  /** Start an agent in a pane at its prompt. `name` matches AGENT_NAME; `args` go to the agent's own CLI. */
  startAgent(paneId: string, kind: string, name: string, args?: string[]): Promise<AgentInfo>;
  /** Type a prompt into an agent and submit it. */
  promptAgent(target: string, text: string): Promise<AgentInfo>;
  /** Every agent kind the driver can start. */
  agentKinds(): Promise<string[]>;
  renameSpace(workspaceId: string, label: string): Promise<unknown>;
  renameTab(tabId: string, label: string): Promise<unknown>;
  /** null clears the label. */
  renamePane(paneId: string, label: string | null): Promise<unknown>;
  /** null goes back to the kind's name. */
  renameAgent(paneId: string, name: string | null): Promise<unknown>;
  splitPane(params: PaneSplitParams): Promise<PaneInfo>;
  closePane(paneId: string): Promise<unknown>;
  closeTab(tabId: string): Promise<unknown>;
  /** A space with linked worktree spaces needs `group` (they close too). */
  closeSpace(workspaceId: string, group?: boolean): Promise<unknown>;
}

/** Which text of a pane to read: a shell's recent output, unwrapped, or what agent detection looks at. */
export type PaneReadSource = 'recent_unwrapped' | 'detection';

/** Reading what panes show and run (activity.ts). */
export interface PaneReader {
  /** The pane's foreground process tree. */
  processInfo(paneId: string): Promise<PaneProcessInfo>;
  /** The last `lines` lines of the pane's text. */
  readText(paneId: string, source: PaneReadSource, lines: number): Promise<string>;
}

/** Hearing that the session changed. Events only mean "re-read": the snapshot is the truth. */
export interface ChangeFeed {
  /** The session as it is now. */
  snapshot(): Promise<BackendSnapshot>;
  /**
   * Calls `onEvent` when something changed in the session or in one of `paneIds` (agent status).
   * `onEnd` fires once when the feed stops (not after dispose()); `onAck` once it's live.
   */
  subscribe(paneIds: readonly string[], onEvent: () => void, onEnd: (err?: Error) => void, opts?: { onAck?: () => void }): Subscription;
}

export interface Backend extends ChangeFeed, PaneReader {
  readonly id: DriverId;
  readonly capabilities: BackendCapabilities;
  readonly actions: BackendActions;
  /** The session exactly as the backend reports it (Show Raw Session Snapshot). */
  rawSnapshot(): Promise<unknown>;
  /** Make this space the focused one (best effort). */
  focusSpace(spaceId: string): Promise<void>;
  /** Focus an agent; it also marks a done agent seen. */
  focusAgent(paneId: string): Promise<void>;
  /**
   * Another window runs this space (a driver with a session per window): that window's extension
   * host pid, so the space opens there. Undefined when it's this window's, or the driver has one session for all.
   */
  windowOf?(spaceId: string): number | undefined;
  /** Stop what the driver runs itself (Herdr's panes keep running in Herdr). */
  dispose?(): void;
}
