// Creating, renaming and closing Herdr spaces/tabs and starting agents. Typed wrappers over the
// socket API; every create defaults to focus:false so Herdr's own view (e.g. in your terminal)
// doesn't jump. No vscode imports (tested against the mock server).

import type { HerdrClient } from './herdrClient';
import type {
  AgentInfo,
  AgentRenameParams,
  AgentManifestStatusResult,
  AgentPromptedResult,
  AgentSessionInfo,
  AgentStartedResult,
  AgentStartParams,
  PaneInfo,
  PaneInfoResult,
  PaneRenameParams,
  PaneSplitParams,
  PaneTarget,
  TabCreatedResult,
  TabCreateParams,
  TabInfo,
  WorkspaceCreatedResult,
  WorkspaceCreateParams,
  WorkspaceInfo,
  WorktreeCreatedResult,
  WorktreeCreateParams,
  WorktreeInfo,
} from './herdrTypes';

/** Agent kinds `herdr agent start --kind` accepts (herdr 0.9.1), with display names. */
export const AGENT_KINDS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kiro: 'Kiro',
  cursor: 'Cursor',
  gemini: 'Gemini',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  amp: 'Amp',
  agy: 'Antigravity',
  cline: 'Cline',
  devin: 'Devin',
  droid: 'Droid',
  grok: 'Grok',
  hermes: 'Hermes',
  kilo: 'Kilo Code',
  kimi: 'Kimi',
  mastracode: 'Mastra Code',
  qodercli: 'Qoder',
  qwen: 'Qwen',
  pi: 'Pi',
  omp: 'omp',
  letta: 'Letta',
  maki: 'Maki',
  muse: 'Muse',
};

/** Herdr's rule for agent names (they double as CLI targets): lowercase, digits, - and _. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** A valid agent name from any text ("Reviewer Bot" -> "reviewer-bot"); undefined when nothing usable is left. */
export function agentSlug(text: string): string | undefined {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return AGENT_NAME.test(s) ? s : undefined;
}

/** A free agent name for a new agent of this kind: "claude", then "claude-2", "claude-3", ... */
export function agentName(kind: string, taken: Iterable<string>): string {
  const base = kind.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 28) || 'agent';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** "claude" -> "Claude"; unknown kinds are title-cased. */
export const agentTitle = (kind: string) => AGENT_KINDS[kind.toLowerCase()] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

/**
 * The arguments that make an agent resume its own conversation, from the session Herdr stored for it
 * (agent_session). Only agents whose CLI resumes by id; undefined means the agent starts a fresh one.
 */
export function resumeArgs(kind: string | undefined, session: AgentSessionInfo | null | undefined): string[] | undefined {
  if (!session || session.kind !== 'id' || !session.value) {
    return undefined;
  }
  const k = kind?.toLowerCase();
  if (k === 'claude') {
    return ['--resume', session.value];
  }
  if (k === 'codex') {
    return ['resume', session.value];
  }
  return undefined;
}

/** How long to wait for an agent to be ready (Herdr's default is 30s, max 300s). */
const AGENT_START_TIMEOUT_MS = 60_000;
/** A pane Herdr just created isn't at its prompt yet ("agent_pane_busy"); retry this long. */
const PANE_READY_TIMEOUT_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Requester = Pick<HerdrClient, 'request'>;

/**
 * worktree.create's params as Herdr checks them: the repo comes from a space (`workspace_id`) or a folder
 * (`cwd`), not both ("only one of workspace_id or cwd may be supplied"), and exactly one of a new `branch`
 * or an existing `path` ("exactly one of path or branch is required").
 */
export type WorktreeCreate = Omit<WorktreeCreateParams, 'workspace_id' | 'cwd' | 'branch' | 'path'> &
  ({ workspace_id: string; cwd?: never } | { cwd: string; workspace_id?: never }) &
  ({ branch: string; path?: never } | { path: string; branch?: never });

export interface Created {
  tab: TabInfo;
  /** The new tab's first pane. */
  pane: PaneInfo;
}

export class HerdrActions {
  constructor(private client: Requester) {}

  /** New tab in a space (a fresh shell in `cwd`, or the space's default directory). */
  async createTab(params: TabCreateParams): Promise<Created> {
    const r = await this.client.request<TabCreatedResult>('tab.create', { focus: false, ...params });
    return { tab: r.tab, pane: r.root_pane };
  }

  /** New space (workspace) rooted at `cwd`. */
  async createSpace(params: WorkspaceCreateParams): Promise<Created & { workspace: WorkspaceInfo }> {
    const r = await this.client.request<WorkspaceCreatedResult>('workspace.create', { focus: false, ...params });
    return { workspace: r.workspace, tab: r.tab, pane: r.root_pane };
  }

  /** New space on a new git worktree of the repo at `cwd` (or of `workspace_id`'s repo). */
  async createWorktreeSpace(params: WorktreeCreate): Promise<Created & { workspace: WorkspaceInfo; worktree: WorktreeInfo }> {
    const r = await this.client.request<WorktreeCreatedResult>('worktree.create', { focus: false, ...params }, 30_000);
    return { workspace: r.workspace, tab: r.tab, pane: r.root_pane, worktree: r.worktree };
  }

  /**
   * Delete a worktree space: closes the space and removes its worktree folder. Herdr refuses when the
   * worktree has uncommitted changes unless `force` (which discards them).
   */
  removeWorktree(workspaceId: string, force = false) {
    return this.client.request('worktree.remove', { workspace_id: workspaceId, ...(force && { force: true }) }, 30_000);
  }

  /**
   * Start an agent in a pane that is at its shell prompt; resolves once the agent is ready.
   * `name` must match AGENT_NAME and be unused (see agentName()). `args` go to the agent's own CLI
   * (e.g. resumeArgs()).
   */
  async startAgent(paneId: string, kind: string, name: string, args?: string[]): Promise<AgentInfo> {
    const params: AgentStartParams = { pane_id: paneId, kind, name, timeout_ms: AGENT_START_TIMEOUT_MS };
    if (args?.length) {
      params.args = args;
    }
    const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
    for (;;) {
      try {
        const r = await this.client.request<AgentStartedResult>('agent.start', params, AGENT_START_TIMEOUT_MS + 5_000);
        return r.agent;
      } catch (e) {
        const code = (e as { code?: unknown } | undefined)?.code;
        if (code !== 'agent_pane_busy' || Date.now() > deadline) {
          throw e;
        }
        await sleep(250);
      }
    }
  }

  /**
   * Type a prompt into an agent and submit it, as if you typed it in its pane. Returns right away; the
   * agent's status changes once it starts working.
   */
  async promptAgent(target: string, text: string): Promise<AgentInfo> {
    const r = await this.client.request<AgentPromptedResult>('agent.prompt', { target, text });
    return r.agent;
  }

  /** The agent kinds Herdr knows how to detect (its agent manifests), e.g. claude, codex, gemini. */
  async agentKinds(): Promise<string[]> {
    const r = await this.client.request<AgentManifestStatusResult>('server.agent_manifests');
    return r.manifests.map((m) => m.agent);
  }

  renameSpace(workspaceId: string, label: string) {
    return this.client.request('workspace.rename', { workspace_id: workspaceId, label });
  }

  renameTab(tabId: string, label: string) {
    return this.client.request('tab.rename', { tab_id: tabId, label });
  }

  /** Clearing the label (null) falls back to the tab name / "Tab N". */
  renamePane(paneId: string, label: string | null) {
    const params: PaneRenameParams = { pane_id: paneId, label };
    return this.client.request('pane.rename', params);
  }

  /** Rename an agent (its name in Herdr and in the sidebar). */
  renameAgent(paneId: string, name: string | null) {
    const params: AgentRenameParams = { target: paneId, name };
    return this.client.request('agent.rename', params);
  }

  /** Split a pane: a new shell next to it in the same Herdr tab. */
  async splitPane(params: PaneSplitParams): Promise<PaneInfo> {
    const r = await this.client.request<PaneInfoResult>('pane.split', { focus: false, ...params });
    return r.pane;
  }

  /** Closes one pane in Herdr: its process ends. */
  closePane(paneId: string) {
    const params: PaneTarget = { pane_id: paneId };
    return this.client.request('pane.close', params);
  }

  /** Closes the tab in Herdr: its panes' processes end. */
  closeTab(tabId: string) {
    return this.client.request('tab.close', { tab_id: tabId });
  }

  /**
   * Closes the space in Herdr: every tab and process in it ends. A space with linked worktree
   * spaces fails with code "workspace_group_close_required" unless `group` closes them too.
   */
  closeSpace(workspaceId: string, group = false) {
    return this.client.request('workspace.close', { workspace_id: workspaceId, ...(group && { close_group: true }) });
  }
}
