// Everything the sidebar webview draws, as plain JSON. Built from the normalized model plus
// what only the extension knows (git, mounted folders, attached terminals, pane activity).
// The webview (media/panel.js) only renders this; it never talks to Herdr.
// No vscode imports (tested standalone).

import * as os from 'os';
import type { PaneActivity } from './activity';
import type { ProviderUsage } from './usage';
import type { DownReason } from './connection';
import type { GitInfo } from './gitInfo';
import type { AgentStatus, Model, Pane, Space, Tab } from './model';
import { agentTitle } from './herdrActions';

export interface PaneView {
  id: string;
  spaceId: string;
  kind: 'agent' | 'shell';
  /** Agents: "Claude", "Kiro", or Herdr's display name. Shells: pane label, tab name or command. */
  name: string;
  /** Agents: task / terminal title. Shells: unused (see shell). */
  detail?: string;
  /** Agents only. */
  status?: AgentStatus;
  stateLabel?: string;
  agentKind?: string;
  /** Epoch ms the agent entered its current status (observed locally). */
  since?: number;
  /** Herdr's focused pane. */
  focused: boolean;
  /** An attach terminal for this pane is open in VS Code. */
  attached: boolean;
  /** Tab label when it adds information (not a bare number, not equal to the name). */
  tab?: string;
  /** Extra metadata worth a chip: model, $tokens. */
  chips: string[];
  /** Agents: one-line summary of the latest reply (Claude's "※ recap", else the last line). */
  headline?: string;
  /** Agents needing attention: the last lines of their screen. */
  preview: string[];
  shell?: {
    state: 'prompt' | 'running' | 'unknown';
    command?: string;
    typed?: string;
    output: string[];
    failed: boolean;
    changedAt?: number;
  };
  cwd?: string;
}

export interface SpaceView {
  id: string;
  label: string;
  /** cwd with the home directory shortened to ~ */
  path?: string;
  status?: AgentStatus;
  /** Herdr's focused workspace. */
  focused: boolean;
  /** Mounted as a folder in this VS Code window. */
  mounted: boolean;
  counts: Record<AgentStatus, number>;
  git?: GitInfo;
  worktree: boolean;
  tokens: string[];
  agents: PaneView[];
  shells: PaneView[];
}

/** The connection, as the sidebar shows it (see Conn in extension.ts). */
export interface ViewConnection {
  kind: 'connecting' | 'connected' | 'reconnecting' | 'starting' | 'down';
  reason?: DownReason;
  socket?: string;
  customSocket?: boolean;
  binary?: string;
  detail?: string;
  version?: string;
  protocol?: number;
  /** The Herdr protocol this build was generated against. */
  expectedProtocol: number;
}

export interface ViewState {
  /** A snapshot is shown (possibly the last one, while reconnecting). */
  connected: boolean;
  connection: ViewConnection;
  showShells: boolean;
  totals: Record<AgentStatus, number> & { agents: number; shells: number };
  /** Blocked agents first, then done; oldest first within each. */
  attention: PaneView[];
  spaces: SpaceView[];
  /** Plan usage of the coding agents with local data (Claude Code, Codex, Kiro). */
  usage: ProviderUsage[];
  /** Shown at the bottom of the sidebar. */
  versions?: { cockpit: string; herdr?: string };
}

export interface ViewInputs {
  model?: Model;
  showShells: boolean;
  since(paneId: string): number | undefined;
  git(cwd: string | undefined): GitInfo | undefined;
  mounted(space: Space): boolean;
  attached(paneId: string): boolean;
  activity(paneId: string): PaneActivity | undefined;
  usage: ProviderUsage[];
  connection: ViewConnection;
  /** `activity`: busy and recently active spaces first (orderByActivity); `herdr`: Herdr's order. */
  order?: 'activity' | 'herdr';
  /** When a space was last active (an agent changed state, it was focused), if known. */
  lastActive?(space: Space): number | undefined;
  versions?: { cockpit: string; herdr?: string };
}

/**
 * Spaces with an agent working or waiting on you first, then the most recently active; ties keep Herdr's order.
 */
export function orderByActivity(spaces: Space[], lastActive: (s: Space) => number | undefined): Space[] {
  const busy = (s: Space) => s.agents.some((a) => a.status === 'working' || a.status === 'blocked');
  return spaces
    .map((s, i) => ({ s, i, busy: busy(s), at: lastActive(s) ?? 0 }))
    .sort((a, b) => Number(b.busy) - Number(a.busy) || b.at - a.at || a.i - b.i)
    .map((x) => x.s);
}

const home = os.homedir();
const tilde = (p?: string) => (p && home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
const emptyCounts = (): Record<AgentStatus, number> => ({ idle: 0, working: 0, blocked: 0, done: 0, unknown: 0 });
const meaningfulTab = (tab: Tab | undefined, name: string) =>
  tab && !/^\d+$/.test(tab.label) && tab.label !== name ? tab.label : undefined;

/**
 * Claude prints "※ recap: ..." hard-wrapped over several lines; otherwise use the last line,
 * pulling in the line before when the last one is a wrapped continuation (starts lowercase).
 */
export function headline(lines: string[]): string | undefined {
  const i = lines.map((l) => l.trimStart().startsWith('※ recap:')).lastIndexOf(true);
  if (i >= 0)
    return lines
      .slice(i)
      .map((l) => l.trim())
      .join(' ')
      .replace(/^※ recap:\s*/, '');
  // Skip timing lines like "✻ Churned for 5s · done 12:18 PM": they say when, not what.
  const content = lines.filter((l) => !STATUS_LINE.test(l.trim()));
  const last = content[content.length - 1]?.trim();
  if (last && /^[a-z]/.test(last) && content.length > 1) return `${content[content.length - 2].trim()} ${last}`;
  return last || lines[lines.length - 1]?.trim() || undefined;
}

/** An agent's "<glyph> <Verb>ed for 1m 59s · done …" status line. */
const STATUS_LINE = /^[^\w\s]\s+\w+ for \d+[smh]\b/;

/**
 * The pane's name in the sidebar and on its VS Code terminal tab (they must match).
 * Agents: Herdr's display name or a name you chose, else the agent's terminal title (Claude Code's
 * session name), else the agent kind ("Claude"). Shells: the pane label, else the tab label, else
 * "Tab N" for Herdr's numbered tabs. Open tabs follow changes through `AttachTerminals.rename`.
 */
export type AgentNames = 'title' | 'herdr';
/** The `herdr.agentNames` setting: `title` lets an unnamed agent show its terminal title, `herdr` doesn't. */
let agentNames: AgentNames = 'title';
export function setAgentNames(mode: AgentNames): void {
  agentNames = mode;
}

export function paneName(tab: Tab | undefined, p: Pane): string {
  if (p.isAgent) {
    const a = p.raw.agent;
    if (a?.display_agent) return a.display_agent;
    const kind = p.agentKind;
    // Names we generate ("claude", "claude-2") read better as "Claude", "Claude 2".
    const generated = a?.name && kind ? new RegExp(`^${kind.replace(/[^a-z0-9_-]/gi, '')}(?:-(\\d+))?$`).exec(a.name) : null;
    if (a?.name && !generated) return a.name;
    const title = kind ? agentTitle(kind) : p.label;
    // Claude Code titles its terminal with the session name. Skip default titles ("Claude Code")
    // and "kiro: ~/path"-style ones, which say nothing the space doesn't.
    const session = p.terminalTitle?.trim();
    const useless = !session || session === title || session === 'Claude Code' || /^[~/]/.test(session) ||
      (!!kind && session.toLowerCase().startsWith(kind.toLowerCase() + ':'));
    if (agentNames === 'title' && !useless) {
      return session;
    }
    return generated?.[1] ? `${title} ${generated[1]}` : title;
  }
  if (p.raw.pane?.label) return p.raw.pane.label;
  if (!tab) return 'shell';
  return /^\d+$/.test(tab.label) ? `Tab ${tab.label}` : tab.label;
}

function agentView(space: Space, tab: Tab | undefined, p: Pane, i: ViewInputs): PaneView {
  const kind = p.agentKind;
  const name = paneName(tab, p);
  // Terminal titles are often just "kiro: ~/path" — the path adds nothing next to the space.
  let detail = p.title ?? p.terminalTitle;
  if (detail && kind && detail.toLowerCase().startsWith(kind.toLowerCase() + ':')) detail = detail.slice(kind.length + 1).trim();
  if (detail && (/^[~/]/.test(detail) || detail === name)) detail = undefined;
  const act = i.activity(p.id);
  const lines = act?.output ?? [];
  const status = p.status ?? 'unknown';
  return {
    id: p.id,
    spaceId: space.id,
    kind: 'agent',
    name,
    detail,
    status,
    stateLabel: p.stateLabel,
    agentKind: kind,
    since: i.since(p.id),
    focused: p.focused,
    attached: i.attached(p.id),
    tab: meaningfulTab(tab, name),
    chips: [p.tokens.model, ...Object.entries(p.tokens).filter(([k]) => k !== 'model').map(([, v]) => v)].filter(
      (x): x is string => !!x,
    ),
    headline: headline(lines),
    preview: status === 'blocked' ? lines.slice(-5) : status === 'done' ? lines.slice(-3) : [],
    cwd: tilde(p.cwd),
  };
}

function shellView(space: Space, tab: Tab | undefined, p: Pane, i: ViewInputs): PaneView {
  const act = i.activity(p.id);
  const name = paneName(tab, p);
  return {
    id: p.id,
    spaceId: space.id,
    kind: 'shell',
    name,
    focused: p.focused,
    attached: i.attached(p.id),
    tab: meaningfulTab(tab, name),
    chips: Object.values(p.tokens),
    preview: [],
    shell: act
      ? { state: act.state ?? 'unknown', command: act.command, typed: act.typed, output: act.output, failed: act.failed, changedAt: act.changedAt }
      : { state: 'unknown', output: [], failed: false },
    cwd: tilde(p.cwd),
  };
}

export function buildViewState(i: ViewInputs): ViewState {
  const totals = { ...emptyCounts(), agents: 0, shells: 0 };
  const all = i.model?.spaces ?? [];
  const ordered = i.order === 'herdr' || !i.lastActive ? all : orderByActivity(all, i.lastActive);
  const spaces: SpaceView[] = ordered.map((sp) => {
    const agents: PaneView[] = [];
    const shells: PaneView[] = [];
    for (const tab of sp.tabs)
      for (const p of tab.panes) (p.isAgent ? agents : shells).push(p.isAgent ? agentView(sp, tab, p, i) : shellView(sp, tab, p, i));
    for (const a of agents) totals[a.status ?? 'unknown']++;
    totals.agents += agents.length;
    totals.shells += shells.length;
    return {
      id: sp.id,
      label: sp.label,
      path: tilde(sp.cwd),
      status: sp.status,
      focused: sp.focused,
      mounted: i.mounted(sp),
      counts: { ...sp.counts },
      git: i.git(sp.cwd),
      worktree: !!sp.worktree?.is_linked_worktree,
      tokens: Object.values(sp.tokens),
      agents,
      shells: i.showShells ? shells : [],
    };
  });
  const rank: Partial<Record<AgentStatus, number>> = { blocked: 0, done: 1 };
  const attention = spaces
    .flatMap((s) => s.agents)
    .filter((a) => a.status === 'blocked' || a.status === 'done')
    .sort((a, b) => rank[a.status!]! - rank[b.status!]! || (a.since ?? 0) - (b.since ?? 0));
  // Usage only for the agents running in Herdr right now.
  const running = new Set(spaces.flatMap((s) => s.agents.map((a) => (a.agentKind ?? '').toLowerCase())));
  return { connected: !!i.model, connection: i.connection, showShells: i.showShells, totals, attention, spaces, usage: i.usage.filter((u) => running.has(u.id)), versions: i.versions };
}
