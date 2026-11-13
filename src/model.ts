// Turns Herdr's session.snapshot into a simple Space > Tab > Pane model.
// Field names and shapes come from src/herdrTypes.ts, generated from `herdr api schema --json`.
// The snapshot is flat: workspaces, tabs, panes and agents are top-level arrays linked by id,
// and every agent also appears as a pane (AgentInfo is PaneInfo plus agent-only fields).

import * as path from 'path';
import type { AgentInfo, AgentStatus, PaneInfo, SessionSnapshotResult, WorkspaceInfo, WorkspaceWorktreeInfo } from './herdrTypes';

export type { AgentStatus } from './herdrTypes';

export interface Pane {
  id: string;
  tabId: string;
  workspaceId: string;
  terminalId: string;
  label: string;
  cwd?: string;
  isAgent: boolean;
  agentKind?: string;
  status?: AgentStatus;
  focused: boolean;
  /** Custom label for the current state (state_labels[status]), e.g. "refactoring auth". */
  stateLabel?: string;
  /** Metadata title (e.g. task name set by a hook/plugin). */
  title?: string;
  /** Latest terminal title with spinner stripped. */
  terminalTitle?: string;
  /** Plugin/hook metadata tokens ($summary, $model, $task, ...). */
  tokens: Record<string, string>;
  /** Native agent session reference, if Herdr stored one. */
  session?: string;
  /** Raw records, shown in the tooltip so nothing Herdr reports is hidden. */
  raw: { pane?: PaneInfo; agent?: AgentInfo };
}

export interface Tab {
  id: string;
  workspaceId: string;
  label: string;
  panes: Pane[];
}

export interface Space {
  id: string;
  label: string;
  cwd?: string;
  tabs: Tab[];
  focused: boolean;
  status?: AgentStatus; // rollup
  agents: Pane[];
  counts: Record<AgentStatus, number>;
  tokens: Record<string, string>;
  /** Set when Herdr manages this workspace as a git worktree checkout. */
  worktree?: WorkspaceWorktreeInfo;
  raw?: WorkspaceInfo;
}

export interface Model {
  spaces: Space[];
  focusedSpaceId?: string;
  raw: SessionSnapshotResult;
}

/** First non-empty string. Many schema fields are `string | null` or optional. */
const str = (...vals: (string | null | undefined)[]): string | undefined =>
  vals.find((v): v is string => typeof v === 'string' && v.length > 0);

const tokensOf = (...maps: (Record<string, string> | undefined)[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m ?? {})) if (v) out[k] = v;
  return out;
};

export const emptyCounts = (): Record<AgentStatus, number> => ({ idle: 0, working: 0, blocked: 0, done: 0, unknown: 0 });

const PRIORITY: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };
export const rollup = (ss: (AgentStatus | undefined)[]): AgentStatus | undefined =>
  ss.reduce<AgentStatus | undefined>(
    (best, s) => (s && (!best || PRIORITY[s] > PRIORITY[best]) ? s : best),
    undefined,
  );

function toPane(p: PaneInfo | undefined, a: AgentInfo | undefined, focusedPaneId?: string | null): Pane {
  // AgentInfo carries every PaneInfo field we read except `label`, so either record works as the base.
  const r = (a ?? p)!;
  const agentKind = str(a?.agent, p?.agent);
  const isAgent = !!a || !!agentKind;
  const status = isAgent ? r.agent_status : undefined;
  const labels = a?.state_labels ?? p?.state_labels;
  const title = str(a?.title, p?.title);
  return {
    id: r.pane_id,
    workspaceId: r.workspace_id,
    tabId: r.tab_id,
    terminalId: r.terminal_id,
    cwd: str(r.foreground_cwd, r.cwd),
    isAgent,
    agentKind,
    status,
    stateLabel: status ? str(labels?.[status]) : undefined,
    title,
    terminalTitle: str(r.terminal_title_stripped, r.terminal_title),
    tokens: tokensOf(p?.tokens, a?.tokens),
    session: str(r.agent_session?.value),
    label:
      str(a?.display_agent, p?.display_agent, a?.name, p?.label, title, r.terminal_title_stripped, agentKind) ??
      r.pane_id,
    focused: r.focused || r.pane_id === focusedPaneId,
    raw: { pane: p, agent: a },
  };
}

const URGENCY: Record<AgentStatus, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

/** The panes to attach when switching to a space: agents most urgent first, then shells in tab order. */
export function attachOrder(space: Space, withShells: boolean): Pane[] {
  const agents = [...space.agents].sort((a, b) => URGENCY[a.status ?? 'unknown'] - URGENCY[b.status ?? 'unknown']);
  const shells = withShells ? space.tabs.flatMap((t) => t.panes.filter((p) => !p.isAgent)) : [];
  return [...agents, ...shells];
}

/** Every pane of every space, with its space. */
export function allPanes(m: Model | undefined): { space: Space; pane: Pane }[] {
  return (m?.spaces ?? []).flatMap((space) => space.tabs.flatMap((t) => t.panes.map((pane) => ({ space, pane }))));
}

/** The pane with this id, with its space. */
export function findPane(m: Model | undefined, paneId: string | undefined): { space: Space; pane: Pane } | undefined {
  if (!paneId) {
    return undefined;
  }
  return allPanes(m).find((x) => x.pane.id === paneId);
}

/** Agents waiting on you, most urgent first (blocked, then done), in Herdr's order within each. */
export function needingAttention(m: Model | undefined): { space: Space; pane: Pane }[] {
  const waiting = allPanes(m).filter((x) => x.pane.isAgent && (x.pane.status === 'blocked' || x.pane.status === 'done'));
  // sort is stable, so Herdr's order is kept within each status
  return waiting.sort((a, b) => URGENCY[a.pane.status!] - URGENCY[b.pane.status!]);
}

/** How many agents are in each state. */
export function countByStatus(m: Model | undefined): Record<AgentStatus, number> {
  const counts = emptyCounts();
  for (const sp of m?.spaces ?? []) {
    for (const a of sp.agents) {
      counts[a.status ?? 'unknown']++;
    }
  }
  return counts;
}

/** Normalizes the `result` of a `session.snapshot` request. */
export function normalize(res: SessionSnapshotResult): Model {
  const s = res?.snapshot;
  const missing = (['workspaces', 'tabs', 'panes', 'agents'] as const).filter((k) => !Array.isArray(s?.[k]));
  if (missing.length)
    throw new Error(
      `unexpected session.snapshot shape (missing ${missing.join(', ')}); herdr ${s?.version ?? '?'} protocol ${s?.protocol ?? '?'}`,
    );

  const agentByPane = new Map(s.agents.map((a) => [a.pane_id, a]));

  // Panes (plus any agent whose pane record is missing, so it still gets a row)
  const panes = new Map<string, Pane>();
  for (const p of s.panes) if (!panes.has(p.pane_id)) panes.set(p.pane_id, toPane(p, agentByPane.get(p.pane_id), s.focused_pane_id));
  for (const [pid, a] of agentByPane) if (!panes.has(pid)) panes.set(pid, toPane(undefined, a, s.focused_pane_id));

  // Tabs
  const tabs = new Map<string, Tab>();
  for (const t of s.tabs) tabs.set(t.tab_id, { id: t.tab_id, workspaceId: t.workspace_id, label: t.label || t.tab_id, panes: [] });
  for (const p of panes.values()) {
    let t = tabs.get(p.tabId);
    if (!t) {
      t = { id: p.tabId, workspaceId: p.workspaceId, label: 'tab', panes: [] };
      tabs.set(p.tabId, t);
    }
    t.panes.push(p);
  }

  // Spaces
  const focusedWs = str(s.focused_workspace_id);
  const spaces = new Map<string, Space>();
  for (const w of s.workspaces) {
    spaces.set(w.workspace_id, {
      id: w.workspace_id,
      label: w.label || w.workspace_id,
      cwd: str(w.worktree?.checkout_path),
      tabs: [],
      focused: w.focused || w.workspace_id === focusedWs,
      agents: [],
      counts: emptyCounts(),
      tokens: tokensOf(w.tokens),
      worktree: w.worktree ?? undefined,
      raw: w,
    });
  }
  for (const t of tabs.values()) {
    let sp = spaces.get(t.workspaceId);
    if (!sp) {
      sp = { id: t.workspaceId, label: t.workspaceId, tabs: [], focused: t.workspaceId === focusedWs, agents: [], counts: emptyCounts(), tokens: {} };
      spaces.set(t.workspaceId, sp);
    }
    sp.tabs.push(t);
  }
  for (const sp of spaces.values()) {
    const all = sp.tabs.flatMap((t) => t.panes);
    sp.agents = all.filter((p) => p.isAgent);
    sp.status = rollup(sp.agents.map((a) => a.status));
    for (const a of sp.agents) sp.counts[a.status ?? 'unknown']++;
    // WorkspaceInfo has no cwd; outside a worktree, use the first pane's (foreground) cwd.
    sp.cwd ??= all.find((p) => p.cwd)?.cwd;
  }

  const spaceList = [...spaces.values()];
  return {
    spaces: spaceList,
    focusedSpaceId: focusedWs ?? spaceList.find((x) => x.focused)?.id,
    raw: res,
  };
}

/**
 * The space to start a new worktree from: the space itself, or for a linked worktree space, its repo's main
 * space (same repo, not a linked worktree, or open on the repo's folder). None when that space isn't open.
 */
export function repoSpace(spaces: Space[], s: Space): Space | undefined {
  const wt = s.worktree;
  if (!wt?.is_linked_worktree) {
    return s;
  }
  const root = path.resolve(wt.repo_root);
  return spaces.find((p) => {
    if (p.worktree) {
      return !p.worktree.is_linked_worktree && p.worktree.repo_key === wt.repo_key;
    }
    return !!p.cwd && path.resolve(p.cwd) === root;
  });
}
