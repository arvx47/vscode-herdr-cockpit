// Everything the sidebar webview draws, as plain JSON. Built from the normalized model plus
// what only the extension knows (git, mounted folders, attached terminals, pane activity).
// The webview (webview/sidebar, React) only renders this; it never talks to Herdr.
// No vscode imports (tested standalone).

import type { PaneActivity } from '../state/activity';
import type { ProviderUsage, UsageWindow } from '../agents/usage';
import type { DownReason } from '../drivers/herdr/connection';
import type { GitInfo } from '../util/gitInfo';
import type { AgentStatus, Model, Pane, Space, Tab } from '../state/model';
import { emptyCounts, repoSpace } from '../state/model';
import { agentTitle } from '../agents/agentNames';
import { tildePath } from '../util/paths';
import { TAB_PREFIX } from '../util/brand';
import { AgentProfile, profileOfAgent } from '../agents/agentProfiles';
import { shortCount } from '../util/format';

export interface PaneView {
  id: string;
  spaceId: string;
  kind: 'agent' | 'shell';
  /** Agents: "Claude", "Kiro", or Herdr's display name. Shells: pane label, tab name or command. */
  name: string;
  /** Agents: task / terminal title. Shells: unused (see shell). */
  detail?: string;
  /**
   * Agents whose name is their session's title (or a name given to them): which agent it is, "Claude (work)",
   * shown next to the name so you can tell the accounts apart.
   */
  agentName?: string;
  /** Agents only. */
  status?: AgentStatus;
  stateLabel?: string;
  agentKind?: string;
  /** Epoch ms the agent entered its current status (observed locally). */
  since?: number;
  /** Herdr's focused pane. */
  focused: boolean;
  /**
   * Its tab is the one you're in, in this window (`now`), or the last Herdr tab you were in while you're elsewhere,
   * like a file (`recent`): the row is highlighted, `recent` more faintly.
   */
  active?: 'now' | 'recent';
  /** An attach terminal for this pane is open in VS Code. */
  attached: boolean;
  /** Tab label when it adds information (not a bare number, not the name, nor the agent's). */
  tab?: string;
  /** Extra metadata worth a chip: model, $tokens. */
  chips: string[];
  /** Agents: one-line summary of the latest reply (Claude's "※ recap", else the last line). */
  headline?: string;
  /** Agents: your last message to it (herdr.agentDescription = request), the row's line under its name when known. */
  request?: string;
  /** Agents: what Claude Haiku says it's doing (herdr.agentDescription = summary), with when it was written. */
  summary?: { text: string; at: number };
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
  /** The working folder, when it isn't the space's own (that one is on the space card). */
  cwd?: string;
  /** Expanding the row shows something its two lines don't: without it the row has no chevron. */
  more: boolean;
  /** Its space's name (shown on Needs you rows, which sit outside their space). */
  spaceLabel: string;
  /** Its space's folder is open in this window: right-click offers Attach, else where to open it. */
  spaceMounted: boolean;
  /** Blocked or done with the Needs you section off: framed in its space instead. */
  needs: boolean;
  /** Framed in its status color in its space: working, or `needs`. */
  framed: boolean;
}

export interface SpaceView {
  id: string;
  label: string;
  /** cwd with the home directory shortened to ~ */
  path?: string;
  /**
   * The card's folder line: `text`, the folder shortened to fit (see shortPath()), and for a linked worktree the
   * repository it belongs to (`worktreeOf`; then `text` is the whole folder, on a line of its own).
   */
  folder?: { text: string; worktreeOf?: string };
  status?: AgentStatus;
  /** Herdr's focused workspace. */
  focused: boolean;
  /** Mounted as a folder in this VS Code window. */
  mounted: boolean;
  /** Open in this window (its own space, or one of its folders): listed under "This window". */
  here: boolean;
  /** Not here but open in another window of this editor: listed under "Other windows". */
  elsewhere: boolean;
  /** Unfolded until you fold it: open here, Herdr's focused space, or an agent needs you. */
  defaultOpen: boolean;
  /** The Shells group starts unfolded when it's short. */
  shellsDefaultOpen: boolean;
  counts: Record<AgentStatus, number>;
  git?: GitInfo;
  worktree: boolean;
  tokens: string[];
  /** Agents, then shells, each in Herdr's order unless you dragged them (ViewInputs.paneOrder). */
  agents: PaneView[];
  shells: PaneView[];
  /** You dragged its rows into an order of your own (the card's menu offers Reset Row Order). */
  reordered: boolean;
  /**
   * herdr.groupWorktrees: a worktree space listed right under its repository's card (same section), drawn indented
   * below it. The repository space's id.
   */
  under?: string;
}

/** The connection, as the sidebar shows it (see Conn in sync.ts). */
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

/** How full a plan-limit window is: under 60%, under 85%, or more. */
export type UsageLevel = 'ok' | 'warn' | 'high';

/** A provider's usage, with what the sidebar shows worked out. */
export interface UsageView extends ProviderUsage {
  /** The plan as the provider's own app names it ("team" is ChatGPT Business). */
  planName?: string;
  windows: (UsageWindow & { level: UsageLevel })[];
  /** The folded Usage heading's number: the 5-hour window, else the first one, credits or tokens. */
  summary: { text: string; level: UsageLevel };
  /** The "Today" lines, one idea each: tokens and the share read from cache, the cost per token, lines changed. */
  todayLines?: string[];
  /** Codex credits beyond the plan's windows ("12.5 credits left", "unlimited credits"). */
  creditsText?: string;
}

/** How the Spaces list is split. */
export interface SpacesLayout {
  /** "This window" on top, then "Other windows" and "Other spaces" folded below; else one plain list. */
  split: boolean;
  /** "Other windows" and "Other spaces" start unfolded (this window has no space of its own). */
  othersOpenByDefault: boolean;
  /** This window has folders but no space for them: the card offering to create or add one. */
  noSpaceHere?: { name: string; canAdd: boolean };
}

export interface ViewState {
  /** A snapshot is shown (possibly the last one, while reconnecting). */
  connected: boolean;
  connection: ViewConnection;
  showShells: boolean;
  totals: Record<AgentStatus, number> & { agents: number; shells: number };
  /**
   * "Needs you": blocked agents first, then done; oldest first within each. Only this window's: agents of a
   * space open here, or with a tab open here. Empty when the section is turned off (needsYou false).
   */
  attention: PaneView[];
  /** The Needs you section is on; when off, blocked and done agents are framed in their space instead (PaneView.needs). */
  needsYou: boolean;
  /**
   * herdr.framedRows: how a framed agent row in a space looks (PaneView.framed). `outline`: the border in its status
   * color and no fill, so only the row of the tab you're in has a background; `filled`: a tinted fill too.
   */
  framedRows: FramedRows;
  spaces: SpaceView[];
  /** You dragged spaces into an order of your own (ViewInputs.spaceOrder; a card's menu offers Reset Space Order). */
  spacesReordered: boolean;
  layout: SpacesLayout;
  /** Plan usage of the coding agents with local data (Claude Code, Codex, Kiro). */
  usage: UsageView[];
  /** Shown at the bottom of the sidebar. `driver`: the driver's name when it isn't Herdr. */
  versions?: { cockpit: string; herdr?: string; driver?: string };
  /** The driver makes git worktree spaces (else the cards have no New worktree button). */
  worktrees: boolean;
  /**
   * A window with folders of its own (not the Cockpit window, not an empty one): the sidebar always splits it into
   * "This window" and "Other spaces", with a card offering to create or add a space when none is open here.
   */
  thisWindow?: { name: string };
  /** The row of the tab you're in (PaneView.active `now`): the sidebar unfolds what hides it and scrolls to it. */
  activeRow?: { id: string; spaceId: string; kind: 'agent' | 'shell'; group: 'here' | 'elsewhere' | 'others' };
}

export interface ViewInputs {
  model?: Model;
  showShells: boolean;
  since(paneId: string): number | undefined;
  git(cwd: string | undefined): GitInfo | undefined;
  mounted(space: Space): boolean;
  attached(paneId: string): boolean;
  activity(paneId: string): PaneActivity | undefined;
  /** An agent's last message from you (agents/sessionText.ts), when herdr.agentDescription is request. */
  request?(paneId: string): string | undefined;
  /** herdr.agentDescription: with `request`, an agent's row shows only your last message (nothing from its screen). */
  description?: 'request' | 'screen' | 'summary';
  /** An agent's summary (agents/summaries.ts), when herdr.agentDescription is summary and one was written. */
  summary?(paneId: string): { text: string; at: number } | undefined;
  usage: ProviderUsage[];
  connection: ViewConnection;
  /** `activity`: busy and recently active spaces first (orderByActivity); `herdr`: Herdr's order. */
  order?: 'activity' | 'herdr';
  /** When a space was last active (an agent changed state, it was focused), if known. */
  lastActive?(space: Space): number | undefined;
  /** The order you dragged a space's rows into (pane ids), if you did. */
  paneOrder?(space: Space): string[] | undefined;
  /** The order you dragged the spaces into (space names), if you did: it wins over `order` for those spaces. */
  spaceOrder?: string[];
  /** herdr.groupWorktrees: list each worktree space right under its repository's space, indented. */
  groupWorktrees?: boolean;
  versions?: { cockpit: string; herdr?: string; driver?: string };
  /** See ViewState.worktrees (default true). */
  worktrees?: boolean;
  /** Whether a space is open in this window; without it, none are. */
  here?(space: Space): boolean;
  /** Whether another window of this editor has the space open (see SpaceView.elsewhere); without it, none do. */
  elsewhere?(space: Space): boolean;
  /** herdr.showNeedsYou: list blocked and done agents in a "Needs you" section (default false, as the setting). */
  needsYou?: boolean;
  /** See ViewState.framedRows (default `outline`, as the setting). */
  framedRows?: FramedRows;
  /** See ViewState.thisWindow. */
  thisWindow?: { name: string };
  /** The pane of the Herdr tab you're in, or were in last (`now` false): see PaneView.active. */
  activePane?: { id: string; now: boolean };
}

/** herdr.framedRows: see ViewState.framedRows. */
export type FramedRows = 'outline' | 'filled';

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

function tilde(p?: string): string | undefined {
  if (!p) {
    return p;
  }
  return tildePath(p);
}
/** The tab's label when it says something the names don't: not a bare number, not one of them in other case. */
function meaningfulTab(tab: Tab | undefined, ...names: (string | undefined)[]): string | undefined {
  if (!tab || /^\d+$/.test(tab.label) || names.some((n) => !!n && tab.label.toLowerCase() === n.toLowerCase())) {
    return undefined;
  }
  return tab.label;
}

/** The pane's folder, unless it's the space's own. */
function ownCwd(p: Pane, space: Space): string | undefined {
  if (!p.cwd || p.cwd === space.cwd) {
    return undefined;
  }
  return tilde(p.cwd);
}

const PLAN_NAMES: Record<string, string> = { team: 'Business', pro: 'Pro', plus: 'Plus', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };

function usageLevel(pct: number): UsageLevel {
  if (pct >= 85) {
    return 'high';
  }
  if (pct >= 60) {
    return 'warn';
  }
  return 'ok';
}

export function usageView(u: ProviderUsage): UsageView {
  const windows = u.windows.map((w) => ({ ...w, level: usageLevel(w.usedPercent) }));
  const w = windows.find((x) => x.label === '5h') ?? windows[0];
  let summary: UsageView['summary'] = { text: '—', level: 'ok' };
  if (w) {
    summary = { text: `${w.label} ${Math.round(w.usedPercent)}%`, level: w.level };
  } else if (u.credits) {
    summary = { text: `${u.credits.month.toFixed(1)} cr`, level: 'ok' };
  } else if (u.block) {
    summary = { text: `${shortCount(u.block.tokens)} tok`, level: 'ok' };
  }
  let planName: string | undefined;
  if (u.plan) {
    planName = PLAN_NAMES[u.plan] ?? u.plan.charAt(0).toUpperCase() + u.plan.slice(1);
  }
  const view: UsageView = { ...u, windows, summary, planName };
  const lines = todayLines(u);
  if (lines.length) {
    view.todayLines = lines;
  }
  if (u.codexCredits?.unlimited) {
    view.creditsText = 'unlimited credits';
  } else if (u.codexCredits?.balance !== undefined) {
    view.creditsText = `${u.codexCredits.balance.toFixed(1)} credits left`;
  }
  return view;
}

/** Lines changed: exact with a thousands separator up to 99,999 (a day's edits), short above. */
function lineCount(n: number): string {
  if (n < 100_000) {
    return n.toLocaleString('en-US');
  }
  return shortCount(n);
}

/**
 * A provider's "Today" lines (since midnight), one idea each so they read at a glance; empty when it did
 * nothing today: "Today: 203.6M tokens, 98% from cache", "$72.67 if billed per token", "+4,536 −141 lines of code".
 */
export function todayLines(u: ProviderUsage): string[] {
  const t = u.today;
  if (!t) {
    return [];
  }
  const lines: string[] = [];
  const all = t.tokens + t.cacheRead;
  if (all > 0) {
    let tokens = `Today: ${shortCount(all)} tokens`;
    // Most of an agent's input is re-read from the prompt cache, which costs about a tenth.
    const cached = Math.round((t.cacheRead / all) * 100);
    if (cached > 0) {
      tokens += `, ${cached}% from cache`;
    }
    lines.push(tokens);
  }
  if (t.costUSD && t.costUSD >= 0.005) {
    lines.push(`$${t.costUSD.toFixed(2)} if billed per token`);
  }
  if (t.linesAdded || t.linesRemoved) {
    lines.push(`+${lineCount(t.linesAdded ?? 0)} −${lineCount(t.linesRemoved ?? 0)} lines of code`);
  }
  return lines;
}

/**
 * Claude prints "※ recap: ..." hard-wrapped over several lines; otherwise use the last line,
 * pulling in the line before when the last one is a wrapped continuation (starts lowercase).
 */
export function headline(lines: string[]): string | undefined {
  const i = lines.map((l) => l.trimStart().startsWith('※ recap:')).lastIndexOf(true);
  if (i >= 0) {
    return lines
      .slice(i)
      .map((l) => l.trim())
      .join(' ')
      .replace(/^※ recap:\s*/, '');
  }
  // Skip timing lines like "✻ Churned for 5s · done 12:18 PM": they say when, not what.
  const content = lines.filter((l) => !STATUS_LINE.test(l.trim()));
  const last = content[content.length - 1]?.trim();
  if (last && /^[a-z]/.test(last) && content.length > 1) {
    return `${content[content.length - 2].trim()} ${last}`;
  }
  return last || lines[lines.length - 1]?.trim() || undefined;
}

/** A shell's default terminal title: "user@host:~/path" or "user@host: /path". */
const SHELL_TITLE = /^[\w.-]+@[\w.-]+:\s?[~/]/;

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

/** The renamed and customized rows of herdr.agents: their agents ("claude-work", "claude-work-2") show the row's name. */
let profileRows: readonly AgentProfile[] = [];
export function setProfileNames(profiles: readonly AgentProfile[]): void {
  profileRows = profiles;
}

/**
 * The row of each agent Herdr has no row's name for, from the Claude Code account its process runs in (pane id →
 * row name, filled by extension.ts syncAccountRows()): `claude-work` typed in a shell, or an agent Herdr resumed.
 */
let accountRows: ReadonlyMap<string, string> = new Map();
export function setAccountRows(rows: ReadonlyMap<string, string>): void {
  accountRows = rows;
}

/** The row an agent was started from, by its name: "claude-work" and "claude-work-2" → "Claude (work)". */
function profileAgentName(agentName: string | null | undefined): string | undefined {
  return profileOfAgent(profileRows, agentName ?? undefined)?.name;
}

/** A Claude agent's row from its account (an id Herdr gave another agent kind since doesn't count). */
function accountRowOf(p: Pane): string | undefined {
  if (p.agentKind !== 'claude') {
    return undefined;
  }
  return accountRows.get(p.id);
}

/** The agent list row an agent comes from: by its name in Herdr, else by the account its process runs in. */
export function agentRowOf(p: Pane): string | undefined {
  if (!p.isAgent) {
    return undefined;
  }
  return profileAgentName(p.raw.agent?.name) ?? accountRowOf(p);
}

/**
 * An agent's name in two parts: `base`, its row's or agent's name ("Claude", "Claude (work)"; not the number in
 * Herdr's unique name, "claude-work-2"), and `own`, when it has one: a name Herdr or someone gave it, or the session's title (Claude Code titles its
 * terminal with it). The sidebar shows `own`, else `base`; the tab shows both ("Claude: Fix login").
 */
export function agentNameParts(p: Pane): { base: string; own?: string } {
  const a = p.raw.agent;
  const kind = p.agentKind;
  let kindTitle = p.label;
  if (kind) {
    kindTitle = agentTitle(kind);
  }
  // Names we generate ("claude", "claude-2", or a row's "claude-work-2") read as "Claude" or "Claude (work)": the
  // number only keeps Herdr's names unique. Any other name was chosen by someone and wins.
  let base = kindTitle;
  let chosen: string | undefined;
  const fromProfile = profileAgentName(a?.name);
  if (fromProfile) {
    base = fromProfile;
  } else {
    // A name Herdr made from the kind ("claude", "claude-2") isn't one someone chose.
    let generated = false;
    if (a?.name && kind) {
      generated = new RegExp(`^${kind.replace(/[^a-z0-9_-]/gi, '')}(?:-\\d+)?$`).test(a.name);
    }
    if (a?.name && !generated) {
      chosen = a.name;
    }
    const fromAccount = accountRowOf(p);
    if (fromAccount) {
      base = fromAccount;
    }
  }
  if (a?.display_agent) {
    return { base, own: a.display_agent };
  }
  if (chosen) {
    return { base, own: chosen };
  }
  // Skip default titles ("Claude Code") and "kiro: ~/path"-style ones, which say nothing the space doesn't.
  const session = p.terminalTitle?.trim();
  const useless = !session || session === base || session === kindTitle || session === 'Claude Code' || /^[~/]/.test(session) ||
    (!!kind && session.toLowerCase().startsWith(kind.toLowerCase() + ':'));
  if (agentNames === 'title' && !useless) {
    return { base, own: session };
  }
  return { base };
}

export function paneName(tab: Tab | undefined, p: Pane): string {
  if (p.isAgent) {
    const { base, own } = agentNameParts(p);
    return own ?? base;
  }
  if (p.raw.pane?.label) {
    return p.raw.pane.label;
  }
  if (!tab) {
    return 'shell';
  }
  return shellTabName(tab.label);
}

/**
 * A folder short enough for one line, keeping what tells folders apart (its end):
 * `~/repos/personal/my-app` stays, `~/a/b/c/d/my-app` becomes `~/…/d/my-app`.
 */
export function shortPath(p: string): string {
  const parts = p.split('/');
  // "/x/y" splits as ["", "x", "y"]: the root is the empty first part.
  if (parts.length <= 4) {
    return p;
  }
  return [parts[0], '…', ...parts.slice(-2)].join('/');
}

/**
 * The card's folder line: where the space lives. A linked worktree says whose checkout it is ("Worktree of app")
 * and gets its whole folder on the next line (shortened, ~/.herdr/worktrees/<repo>/<branch> lost the part that
 * says it's one of Herdr's worktrees).
 */
export function folderLine(sp: Space, spaces: Space[]): { text: string; worktreeOf?: string } | undefined {
  const p = tilde(sp.cwd);
  if (!p) {
    return undefined;
  }
  const line: { text: string; worktreeOf?: string } = { text: shortPath(p) };
  const wt = sp.worktree;
  if (wt?.is_linked_worktree) {
    // The repo's own space by its name in the sidebar, else Herdr's name for the repository.
    const repo = repoSpace(spaces, sp);
    line.worktreeOf = repo?.label ?? wt.repo_name;
    line.text = p;
  }
  return line;
}

/** A shell named after its Herdr tab: Herdr numbers unnamed tabs ("2"), which reads as "Tab 2". */
export function shellTabName(tabLabel: string): string {
  if (/^\d+$/.test(tabLabel)) {
    return `Tab ${tabLabel}`;
  }
  return tabLabel;
}

/** What every Herdr tab's name starts with, so they stand apart from the editor's own terminals. */
export { TAB_PREFIX };

/** A Herdr tab's name from a pane's name: "Herdr: Fix login", "Herdr: Tab 2". */
export function herdrTabName(name: string): string {
  return `${TAB_PREFIX} ${name}`;
}

/**
 * The VS Code tab's name. An agent's says which agent it is, then its session: "Claude: Fix login",
 * "Claude (work)" until the session has a title. A shell's starts with "Herdr:" ("Herdr: Tab 2").
 */
export function tabName(tab: Tab | undefined, p: Pane): string {
  if (p.isAgent) {
    const { base, own } = agentNameParts(p);
    if (own) {
      return `${base}: ${own}`;
    }
    return base;
  }
  return herdrTabName(paneName(tab, p));
}

/** A Herdr tab's label as we left it, and the one it had before (hubFiles.ts TabLabelRecord). */
export interface LabelRecord {
  wrote: string;
  original: string;
}

/** Herdr's tab bar is narrow: longer names are cut, with an ellipsis. */
const MAX_HERDR_LABEL = 40;

/** The name an agent's Herdr tab gets: its tab name ("Claude: Fix login"), cut to fit Herdr's tab bar. */
export function herdrLabelFor(tab: Tab, p: Pane): string {
  // By characters, not UTF-16 units: a cut through an emoji leaves half of it, which Herdr refuses (a rename that
  // then fails on every snapshot).
  const chars = Array.from(tabName(tab, p));
  if (chars.length <= MAX_HERDR_LABEL) {
    return chars.join('');
  }
  return `${chars.slice(0, MAX_HERDR_LABEL - 1).join('').trimEnd()}…`;
}

/**
 * A Herdr tab's label when it's one of its own: not empty, not its id (what normalize() shows for no label) and not
 * Herdr's number ("3"; a new tab gets its own). The one rule for reusing a label on another tab (Reopen Closed Tab)
 * and for telling a label someone gave the tab from Herdr's default.
 */
export function ownTabLabel(label: string | undefined, tabId: string): string | undefined {
  if (!label || label === tabId || /^\d+$/.test(label)) {
    return undefined;
  }
  return label;
}

/**
 * What to do with a Herdr tab's label so Herdr shows the same name as our tab: undefined = nothing; else `rename`
 * (when set) and the record to keep (`record` undefined = forget the tab).
 * - A tab we labeled (`rec`) whose label you changed since: yours now, forgotten, never touched again.
 * - Still ours and holding just that agent: follows the agent's name.
 * - Still ours but split, or the agent quit: the label it had before comes back (not for an empty one: Herdr shows its id).
 * - Not labeled by us yet: only a tab holding just an agent, still labeled with the agent's name (what New tab gives
 *   it), Herdr's number, or nothing. A label you typed in Herdr, like "OUT-9702", is left alone.
 */
export function herdrTabLabel(tab: Tab, rec: LabelRecord | undefined): { rename?: string; record?: LabelRecord } | undefined {
  const p = tab.panes[0];
  const single = tab.panes.length === 1 && !!p?.isAgent;
  if (rec) {
    if (tab.label !== rec.wrote) {
      return {};
    }
    if (!single) {
      // Back to what it had. Herdr's number is restored too (it's this same tab); only its id means no label.
      if (rec.original === tab.id) {
        return {};
      }
      return { rename: rec.original };
    }
    const want = herdrLabelFor(tab, p);
    if (want === rec.wrote) {
      return undefined;
    }
    return { rename: want, record: { wrote: want, original: rec.original } };
  }
  if (!single) {
    return undefined;
  }
  const names = [agentNameParts(p).base];
  if (p.agentKind) {
    names.push(agentTitle(p.agentKind));
  }
  const fresh = !ownTabLabel(tab.label, tab.id) || names.includes(tab.label);
  if (!fresh) {
    return undefined;
  }
  const want = herdrLabelFor(tab, p);
  if (want === tab.label) {
    return undefined;
  }
  return { rename: want, record: { wrote: want, original: tab.label } };
}

function agentView(space: Space, tab: Tab | undefined, p: Pane, i: ViewInputs): PaneView {
  const kind = p.agentKind;
  const name = paneName(tab, p);
  // Terminal titles are often just "kiro: ~/path" — the path adds nothing next to the space.
  let detail = p.title ?? p.terminalTitle;
  if (detail && kind && detail.toLowerCase().startsWith(kind.toLowerCase() + ':')) {
    detail = detail.slice(kind.length + 1).trim();
  }
  // Paths and shell prompt titles ("user@host:~/code/app") say nothing the space doesn't, and show the user name.
  if (detail && (/^[~/]/.test(detail) || SHELL_TITLE.test(detail) || detail === name)) {
    detail = undefined;
  }
  const act = i.activity(p.id);
  const lines = act?.output ?? [];
  const status = p.status ?? 'unknown';
  const parts = agentNameParts(p);
  let agentName: string | undefined;
  if (parts.own && parts.base !== name) {
    agentName = parts.base;
  }
  // A tab named after the agent ("claude", "Claude (work)") says nothing its logo and name don't.
  // Not the label we keep in step with the tab's name (herdrTabLabel): that's the name again.
  let herdrLabel: string | undefined;
  if (tab) {
    herdrLabel = herdrLabelFor(tab, p);
  }
  const tabLabel = meaningfulTab(tab, name, parts.base, kind, tabName(tab, p), herdrLabel);
  const chips = [p.tokens.model, ...Object.entries(p.tokens).filter(([k]) => k !== 'model').map(([, v]) => v)].filter(
    (x): x is string => !!x,
  );
  let gist = headline(lines);
  let preview: string[] = [];
  if (status === 'blocked') {
    preview = lines.slice(-5);
  } else if (status === 'done') {
    preview = lines.slice(-3);
  }
  if (i.description === 'request') {
    // Only your last message: no task title, recap or screen lines, even when there's no message to show.
    detail = undefined;
    gist = undefined;
    preview = [];
  }
  const cwd = ownCwd(p, space);
  const request = i.request?.(p.id);
  const summary = i.summary?.(p.id);
  // Collapsed, the row shows your last message, else the task, else the gist; expanded, all of them plus the
  // screen, chips and folder.
  // Open, a row shows its one description in full (plus chips and folder): with a chosen one (a summary, your last
  // message) nothing else, so only a long one, or chips and a folder, are worth a chevron.
  let more = !!tabLabel || chips.length > 0 || !!cwd;
  if (summary) {
    // The whole summary, with its age.
    more = true;
  } else if (request) {
    more ||= request.length > 60;
  } else {
    more ||= preview.length > 0 || (!!detail && !!gist && gist !== detail);
  }
  return {
    id: p.id,
    spaceId: space.id,
    kind: 'agent',
    name,
    agentName,
    detail,
    status,
    stateLabel: p.stateLabel,
    agentKind: kind,
    since: i.since(p.id),
    focused: p.focused,
    attached: i.attached(p.id),
    tab: tabLabel,
    chips,
    headline: gist,
    request,
    summary,
    preview,
    cwd,
    more,
    spaceLabel: space.label,
    spaceMounted: i.mounted(space),
    needs: false,
    framed: false,
  };
}

function shellView(space: Space, tab: Tab | undefined, p: Pane, i: ViewInputs): PaneView {
  const act = i.activity(p.id);
  const name = paneName(tab, p);
  const tabLabel = meaningfulTab(tab, name);
  const chips = Object.values(p.tokens);
  const cwd = ownCwd(p, space);
  // Nothing read yet: an unknown state with no output.
  let shell: PaneView['shell'] = { state: 'unknown', output: [], failed: false };
  if (act) {
    shell = { state: act.state ?? 'unknown', command: act.command, typed: act.typed, output: act.output, failed: act.failed, changedAt: act.changedAt };
  }
  // Collapsed, the row shows the command or else what's typed; expanded, both plus output, chips and folder.
  const more = shell.output.length > 0 || (!!shell.command && !!shell.typed) || !!tabLabel || chips.length > 0 || !!cwd;
  return {
    id: p.id,
    spaceId: space.id,
    kind: 'shell',
    name,
    focused: p.focused,
    attached: i.attached(p.id),
    tab: tabLabel,
    chips,
    preview: [],
    shell,
    cwd,
    more,
    spaceLabel: space.label,
    spaceMounted: i.mounted(space),
    needs: false,
    framed: false,
  };
}

/**
 * Rows in the order you dragged them into: the ones in `order` first, in that order, then the rest (panes opened
 * since, or whose ids changed with a Herdr restart) in Herdr's order.
 */
export function applyPaneOrder<T extends { id: string }>(rows: T[], order: string[] | undefined): T[] {
  if (!order?.length) {
    return rows;
  }
  const at = new Map(order.map((id, n) => [id, n]));
  return rows
    .map((r, n) => ({ r, n, at: at.get(r.id) ?? order.length }))
    .sort((a, b) => a.at - b.at || a.n - b.n)
    .map((x) => x.r);
}

/**
 * Spaces in the order you dragged them into: the ones named in `order` first, in that order, then the rest (spaces
 * created since) in the order they came in. By name, like the rest of what's remembered per space: ids change when
 * Herdr restarts.
 */
export function applySpaceOrder<T extends { label: string }>(spaces: T[], order: string[] | undefined): T[] {
  if (!order?.length) {
    return spaces;
  }
  const at = new Map<string, number>();
  order.forEach((label, n) => {
    if (!at.has(label)) {
      at.set(label, n);
    }
  });
  return spaces
    .map((s, n) => ({ s, n, at: at.get(s.label) ?? order.length }))
    .sort((a, b) => a.at - b.at || a.n - b.n)
    .map((x) => x.s);
}

/** A space's shell rows, in the saved order, when shells are shown (herdr.showShellPanes). */
function shownShells(show: boolean | undefined, shells: PaneView[], order: string[] | undefined): PaneView[] {
  if (!show) {
    return [];
  }
  return applyPaneOrder(shells, order);
}

export function buildViewState(i: ViewInputs): ViewState {
  const totals = { ...emptyCounts(), agents: 0, shells: 0 };
  const all = i.model?.spaces ?? [];
  let ordered = all;
  if (i.order !== 'herdr' && i.lastActive) {
    ordered = orderByActivity(all, i.lastActive);
  }
  ordered = applySpaceOrder(ordered, i.spaceOrder);
  const spaces: SpaceView[] = ordered.map((sp) => {
    const agents: PaneView[] = [];
    const shells: PaneView[] = [];
    for (const tab of sp.tabs)
      for (const p of tab.panes) {
        if (p.isAgent) {
          agents.push(agentView(sp, tab, p, i));
        } else {
          shells.push(shellView(sp, tab, p, i));
        }
      }
    const order = i.paneOrder?.(sp);
    for (const a of agents) totals[a.status ?? 'unknown']++;
    totals.agents += agents.length;
    totals.shells += shells.length;
    const mounted = i.mounted(sp);
    const here = !!i.here?.(sp);
    return {
      id: sp.id,
      label: sp.label,
      path: tilde(sp.cwd),
      status: sp.status,
      focused: sp.focused,
      mounted,
      here,
      elsewhere: !here && !!i.elsewhere?.(sp),
      defaultOpen: mounted || sp.focused || sp.counts.blocked + sp.counts.done > 0,
      shellsDefaultOpen: shells.length <= 3,
      counts: { ...sp.counts },
      git: i.git(sp.cwd),
      folder: folderLine(sp, all),
      worktree: !!sp.worktree?.is_linked_worktree,
      tokens: Object.values(sp.tokens),
      agents: applyPaneOrder(agents, order),
      shells: shownShells(i.showShells, shells, order),
      reordered: !!order?.length,
    };
  });
  const rank: Partial<Record<AgentStatus, number>> = { blocked: 0, done: 1 };
  const needsYou = i.needsYou ?? false;
  for (const s of spaces) {
    for (const a of s.agents) {
      if (!needsYou) {
        a.needs = a.status === 'blocked' || a.status === 'done';
      }
      // A working agent stands out in its status color too (blue), like one that's done (green).
      a.framed = a.needs || a.status === 'working';
    }
  }
  const layout = spacesLayout(spaces, i.thisWindow);
  let listed = spaces;
  if (i.groupWorktrees) {
    const repoOf = new Map<string, string>();
    for (const sp of all) {
      const repo = repoSpace(all, sp);
      if (repo && repo.id !== sp.id) {
        repoOf.set(sp.id, repo.id);
      }
    }
    listed = groupUnderRepos(spaces, (id) => repoOf.get(id), layout.split);
  }
  let activeRow: ViewState['activeRow'];
  if (i.activePane) {
    for (const s of spaces) {
      const row = [...s.agents, ...s.shells].find((p) => p.id === i.activePane!.id);
      if (!row) {
        continue;
      }
      if (i.activePane.now) {
        row.active = 'now';
        let group: 'here' | 'elsewhere' | 'others' = 'others';
        if (s.here) {
          group = 'here';
        } else if (s.elsewhere) {
          group = 'elsewhere';
        }
        activeRow = { id: row.id, spaceId: s.id, kind: row.kind, group };
      } else {
        row.active = 'recent';
      }
    }
  }
  let attention: PaneView[] = [];
  if (needsYou) {
    attention = spaces
      .flatMap((s) => s.agents.filter((a) => s.here || a.attached))
      .filter((a) => a.status === 'blocked' || a.status === 'done')
      .sort((a, b) => rank[a.status!]! - rank[b.status!]! || (a.since ?? 0) - (b.since ?? 0));
  }
  // Usage only for the agents running in Herdr right now.
  const running = new Set(spaces.flatMap((s) => s.agents.map((a) => (a.agentKind ?? '').toLowerCase())));
  return {
    connected: !!i.model,
    connection: i.connection,
    showShells: i.showShells,
    totals,
    attention,
    needsYou,
    framedRows: i.framedRows ?? 'outline',
    spaces: listed,
    spacesReordered: !!i.spaceOrder?.length,
    layout,
    // By agent kind: every Claude Code account's card shows while a Claude agent runs.
    usage: i.usage.filter((u) => running.has(u.kind ?? u.id)).map(usageView),
    versions: i.versions,
    worktrees: i.worktrees ?? true,
    thisWindow: i.thisWindow,
    activeRow,
  };
}

/** The sidebar section a space is listed in, when the list is split (spacesLayout). */
function sectionOf(s: SpaceView): string {
  if (s.here) {
    return 'here';
  }
  if (s.elsewhere) {
    return 'elsewhere';
  }
  return 'others';
}

/**
 * herdr.groupWorktrees: each worktree space moved right after its repository's space and marked `under` it, when both
 * are listed in the same section (`split`: This window / Other windows / Other spaces; else one list). Worktrees keep
 * their order among themselves; a worktree whose repository has no space, or is in another section, stays where it was.
 */
export function groupUnderRepos(spaces: SpaceView[], repoOf: (id: string) => string | undefined, split: boolean): SpaceView[] {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const children = new Map<string, SpaceView[]>();
  for (const s of spaces) {
    const repo = byId.get(repoOf(s.id) ?? '');
    if (!repo || repo === s || (split && sectionOf(repo) !== sectionOf(s))) {
      continue;
    }
    if (!children.has(repo.id)) {
      children.set(repo.id, []);
    }
    children.get(repo.id)!.push(s);
  }
  const nested = new Set([...children.values()].flat());
  const out: SpaceView[] = [];
  for (const s of spaces) {
    if (nested.has(s)) {
      continue;
    }
    out.push(s);
    for (const c of children.get(s.id) ?? []) {
      out.push({ ...c, under: s.id });
    }
  }
  return out;
}

/**
 * This window's spaces on top, then those open in other windows ("Other windows"), then the rest ("Other spaces"),
 * when more than one of these has spaces; a window with folders of its own and no space for them always splits,
 * with a card saying so. With nothing here the other two start unfolded, so the list never looks empty.
 */
export function spacesLayout(spaces: SpaceView[], thisWindow: { name: string } | undefined): SpacesLayout {
  const here = spaces.filter((s) => s.here).length;
  const elsewhere = spaces.filter((s) => !s.here && s.elsewhere).length;
  const others = spaces.length - here - elsewhere;
  if (thisWindow && !here) {
    return { split: true, othersOpenByDefault: true, noSpaceHere: { name: thisWindow.name, canAdd: elsewhere + others > 0 } };
  }
  const groups = [here, elsewhere, others].filter((n) => n > 0).length;
  return { split: groups > 1, othersOpenByDefault: groups > 1 && !here };
}
