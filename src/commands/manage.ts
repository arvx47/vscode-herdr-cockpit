// Creating, renaming and closing Herdr spaces and tabs from VS Code: the quick picks, input boxes
// and confirmations around src/drivers/herdr/herdrActions.ts. Every new pane opens straight away in a terminal tab.
import * as vscode from 'vscode';
import { EXTENSION_NAME, MESSAGE_PREFIX } from '../util/brand';
import * as os from 'os';
import * as path from 'path';
import { inDriver } from '../drivers/backend';
import type { BackendActions, BackendCapabilities } from '../drivers/backend';
import { AGENT_KINDS, AGENT_NAME, agentName, agentTitle, resumeArgs } from '../agents/agentNames';
import { errorText } from '../util/errors';
import type { AgentSessionInfo } from '../drivers/herdr/herdrTypes';
import { repoSpace } from '../state/model';
import type { Pane, Space } from '../state/model';
import { agentRowOf, ownTabLabel, paneName, tabName } from '../sidebar/viewState';
import { branchFromInput, branchProblem } from './branchName';
import { ClosedWorktree, closedWorktrees, herdrWorktreeRepos, linkedWorktrees, worktreeLabel, worktreeListFolders } from './worktreeList';
import type { WorktreeState } from '../util/gitInfo';
import { recentFolders } from './recentFolders';
import { tildePath } from '../util/paths';
import { AgentProfile, profileOfAgent } from '../agents/agentProfiles';

/** What a new tab runs: a plain shell, or an agent kind ("claude", "codex", ...), maybe with a profile's environment. */
export interface What {
  kind?: string;
  /** A row of herdr.agents that isn't the plain agent: the pane gets its variables, the agent its name. */
  profile?: AgentProfile;
  /** Herdr tab label; empty = Herdr numbers the tab ("Tab 7"). */
  label?: string;
}

export interface ManageDeps {
  actions: BackendActions;
  /** What the driver can do, for wording (where panes keep running). */
  capabilities: BackendCapabilities;
  /** Re-reads the snapshot until the pane shows up (it normally does right away). */
  findPane(paneId: string): Promise<{ space: Space; pane: Pane } | undefined>;
  /** Re-reads the snapshot until the space shows up with a pane. */
  findSpace(spaceId: string): Promise<Space | undefined>;
  /** Opens the pane in a terminal tab (switching to its space first, like clicking its row). */
  attach(space: Space, pane: Pane, startingAs?: string): Promise<void>;
  agentIcon(kind?: string): vscode.QuickPickItem['iconPath'];
  /** Current spaces, for "new worktree of …". */
  spaces(): Space[];
  /** Current git branch of a folder, when it is a repository. */
  branchOf(cwd?: string): string | undefined;
  /** The branch new worktrees start from (gitInfo.ts mainBranch()); undefined when git can't say. */
  mainBranch(cwd: string): Promise<string | undefined>;
  /** A worktree's uncommitted changes and commits beyond `base` (gitInfo.ts worktreeState()); undefined when git can't say. */
  worktreeState(cwd: string, base?: string): Promise<WorktreeState | undefined>;
  /** Switches this window to the space, like clicking its card. */
  switchTo(space: Space): Promise<unknown>;
  /** The space is open in this window (its folder is one of this window's). */
  isOpenHere(space: Space): boolean;
  /** Agent names in use (agent names must be unique). */
  agentNames(): string[];
  /** The agent kinds the running Herdr knows (its agent manifests); empty when it couldn't say. */
  herdrAgentKinds(): Promise<string[]>;
  /** herdr.agents: the agent list's rows (plain agents, renamed ones, ones with their own environment), in order. */
  agentProfiles(): AgentProfile[];
  renameTerminal(paneId: string, name: string): Promise<void>;
  /** Herdr is connected, offering to start it if not. */
  ensureConnected(): Promise<boolean>;
  log(msg: string): void;
}

const err = errorText;

/** Agent kinds to offer: the ones this extension knows by name, plus any other the running Herdr knows. */
async function knownKinds(deps: ManageDeps): Promise<string[]> {
  const kinds = Object.keys(AGENT_KINDS);
  for (const k of await deps.herdrAgentKinds()) {
    if (!kinds.includes(k)) {
      kinds.push(k);
    }
  }
  return kinds;
}

/** "Shell", "Shell with a name…", then agents with their logos. Undefined if cancelled. */
async function pickWhat(deps: ManageDeps, title: string): Promise<What | undefined> {
  type Item = vscode.QuickPickItem & { what?: What; more?: boolean; named?: boolean; addProfile?: boolean };
  const known = await knownKinds(deps);
  // The rows of herdr.agents, each agent's together (in the order its first row comes).
  const shown: string[] = [];
  for (const p of deps.agentProfiles()) {
    if (!shown.includes(p.kind)) {
      shown.push(p.kind);
    }
  }
  const items: Item[] = [
    { label: 'Shell', iconPath: new vscode.ThemeIcon('terminal'), what: {} },
    { label: 'Shell with a name…', iconPath: new vscode.ThemeIcon('edit'), named: true },
    { label: 'Agents', kind: vscode.QuickPickItemKind.Separator },
    ...agentItems(deps, shown),
    { label: 'More agents…', iconPath: new vscode.ThemeIcon('ellipsis'), more: true },
    ADD_PROFILE_ITEM,
  ];
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'What should the new tab run?' });
  if (!pick) return;
  if (pick.named) {
    const label = await vscode.window.showInputBox({ title, prompt: 'Tab name', placeHolder: 'e.g. dev server' });
    return label?.trim() ? { label: label.trim() } : undefined;
  }
  if (pick.more) {
    return pickAgent(deps, title, shown, known);
  }
  if (pick.addProfile) {
    return openProfileSettings();
  }
  return pick.what;
}

/** A profile in a picker: its name, and which agent and variables it uses. */
function profileItem(deps: ManageDeps, p: AgentProfile): vscode.QuickPickItem & { what: What } {
  if (p.plain) {
    return { label: p.name, description: p.kind, iconPath: deps.agentIcon(p.kind) ?? new vscode.ThemeIcon('hubot'), what: { kind: p.kind } };
  }
  let description = agentTitle(p.kind);
  const vars = Object.keys(p.env);
  if (vars.length) {
    description += ` · ${vars.join(', ')}`;
  }
  return { label: p.name, description, iconPath: deps.agentIcon(p.kind) ?? new vscode.ThemeIcon('hubot'), what: { kind: p.kind, profile: p } };
}

/** Last in the agent lists: opens the Settings page at herdr.agents, where each entry of the list is one table row. */
const ADD_PROFILE_ITEM = {
  label: 'Add or rename agents…',
  description: 'e.g. another Claude Code account',
  iconPath: new vscode.ThemeIcon('add'),
  addProfile: true,
};

/** Opens the setting (no pane is made this time; the change shows in the list next time). */
async function openProfileSettings(): Promise<undefined> {
  await vscode.commands.executeCommand('herdr.openAgents');
  return undefined;
}

/**
 * Each agent's entries together, in herdr.agents' order ("Claude", then "Claude (work)"); an agent without a row
 * (More agents…) is listed plain.
 */
function agentItems(deps: ManageDeps, kinds: readonly string[]): (vscode.QuickPickItem & { what: What })[] {
  const rows = deps.agentProfiles();
  const items: (vscode.QuickPickItem & { what: What })[] = [];
  for (const kind of kinds) {
    const own = rows.filter((x) => x.kind === kind);
    if (!own.length) {
      items.push({ label: agentTitle(kind), description: kind, iconPath: deps.agentIcon(kind) ?? new vscode.ThemeIcon('hubot'), what: { kind } });
    }
    for (const p of own) {
      items.push(profileItem(deps, p));
    }
  }
  return items;
}

/** Any agent Herdr can start (or one herdr.agents names), each with its rows, except `skip`. Undefined if cancelled. */
export async function pickAgent(deps: ManageDeps, title: string, skip: string[] = [], known?: string[]): Promise<What | undefined> {
  known ??= await knownKinds(deps);
  const kinds: string[] = [];
  for (const p of deps.agentProfiles()) {
    if (!kinds.includes(p.kind)) {
      kinds.push(p.kind);
    }
  }
  for (const k of known) {
    if (!kinds.includes(k)) {
      kinds.push(k);
    }
  }
  const items: (vscode.QuickPickItem & { what?: What; addProfile?: boolean })[] = [
    ...agentItems(
      deps,
      kinds.filter((k) => !skip.includes(k)),
    ),
    ADD_PROFILE_ITEM,
  ];
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Agent to start' });
  if (pick?.addProfile) {
    return openProfileSettings();
  }
  return pick?.what;
}

/** The tab label for what a new pane runs: a shell's chosen name, a profile's name, or the agent's. */
function tabLabelFor(what: What): string | undefined {
  if (what.label) {
    return what.label;
  }
  if (what.profile) {
    return what.profile.name;
  }
  if (what.kind) {
    return agentTitle(what.kind);
  }
  return undefined;
}

/**
 * Start an agent in a fresh pane, in the background: the tab is already open, so you watch it
 * launch. Herdr waits until the agent is ready for input.
 */
export function startAgent(deps: ManageDeps, paneId: string, kind: string, where: string, opts: { name?: string; args?: string[]; profile?: AgentProfile } = {}) {
  let name = agentTitle(kind);
  // A profile's agents are named after it ("claude-work", "claude-work-2"), so they can be told apart and
  // a closed one restarted with the same variables.
  let agentId = opts.name;
  let args = opts.args;
  if (opts.profile) {
    name = opts.profile.name;
    agentId ??= agentName(opts.profile.slug, deps.agentNames());
    args = [...opts.profile.args, ...(opts.args ?? [])];
  }
  let verb = 'Starting';
  if (opts.args?.length) {
    verb = 'Resuming';
  }
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${verb} ${name} in ${where}…` },
    async () => {
      try {
        await deps.actions.startAgent(paneId, kind, agentId ?? agentName(kind, deps.agentNames()), args);
      } catch (e) {
        deps.log(`agent.start ${kind} in ${paneId}: ${err(e)}`);
        vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't start ${name}: ${err(e)}`);
      }
    },
  );
}

/** Opens a pane Herdr just created, then starts its agent if one was chosen. */
async function openCreated(deps: ManageDeps, paneId: string, what: What, where: string) {
  const hit = await deps.findPane(paneId);
  if (!hit) {
    vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: the new tab was created but hasn't shown up yet. Click Refresh in the sidebar's ⋯ menu, then click it there.`);
    return;
  }
  await deps.attach(hit.space, hit.pane, what.kind);
  if (what.kind) {
    startAgent(deps, hit.pane.id, what.kind, where, { profile: what.profile });
  }
}

export async function newTab(deps: ManageDeps, space: Space, what?: What) {
  if (!(await deps.ensureConnected())) return;
  what ??= await pickWhat(deps, `New tab in ${space.label}`);
  if (!what) return;
  try {
    const { pane } = await deps.actions.createTab({
      workspace_id: space.id,
      cwd: space.cwd,
      label: tabLabelFor(what),
      ...(what.profile && { env: what.profile.env }),
    });
    await openCreated(deps, pane.pane_id, what, space.label);
  } catch (e) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't create a tab in ${space.label}: ${err(e)}`);
  }
}

/** Split a pane: a new pane next to it in the same Herdr tab, running a shell or an agent you pick. */
export async function splitPane(deps: ManageDeps, space: Space, pane: Pane) {
  if (!(await deps.ensureConnected())) return;
  const name = paneName(space.tabs.find((t) => t.id === pane.tabId), pane);
  const what = await pickWhat(deps, `Split ${name} (${space.label})`);
  if (!what) return;
  try {
    const created = await deps.actions.splitPane({ target_pane_id: pane.id, direction: 'right', cwd: pane.cwd ?? space.cwd, ...(what.profile && { env: what.profile.env }) });
    // "Shell with a name…" names the new pane (its Herdr tab keeps its name).
    if (what.label) {
      await deps.actions.renamePane(created.pane_id, what.label).catch(() => undefined);
    }
    await openCreated(deps, created.pane_id, what, space.label);
  } catch (e) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't split ${name}: ${err(e)}`);
  }
}

/** A Herdr tab you closed in this window, kept so herdr.reopenClosedTab can open it again. */
export interface ClosedTab {
  paneId: string;
  /** Closed in Herdr too. False when only the VS Code tab went away (Keep Running, closeTabInHerdr "never"). */
  closedInHerdr: boolean;
  space: { id: string; label: string; cwd?: string };
  /** The Herdr tab the pane was in; other panes may still be in it. */
  tabId: string;
  tabLabel?: string;
  cwd?: string;
  /** A shell's own pane label. */
  paneLabel?: string;
  agentKind?: string;
  agentName?: string;
  /** The agent list row it came from (by its name, or the Claude account it ran in): it comes back with its variables. */
  agentRow?: string;
  /** The agent's own session, when Herdr stored one: reopening resumes it (resumeArgs()). */
  session?: AgentSessionInfo;
}

export function closedTab(space: Space, pane: Pane): ClosedTab {
  const tab = space.tabs.find((t) => t.id === pane.tabId);
  // Herdr numbers unnamed tabs ("3") or shows their id ("w1:t3"); a new tab gets its own.
  const tabLabel = ownTabLabel(tab?.label, pane.tabId);
  return {
    paneId: pane.id,
    closedInHerdr: false,
    space: { id: space.id, label: space.label, cwd: space.cwd },
    tabId: pane.tabId,
    tabLabel,
    cwd: pane.cwd,
    paneLabel: pane.raw.pane?.label ?? undefined,
    agentKind: pane.isAgent ? pane.agentKind : undefined,
    agentName: pane.raw.agent?.name ?? undefined,
    agentRow: agentRowOf(pane),
    session: pane.raw.agent?.agent_session ?? pane.raw.pane?.agent_session ?? undefined,
  };
}

/**
 * Open a closed tab again. A pane still running in Herdr is just attached. Otherwise a new one is made
 * where it was (next to the panes left in its Herdr tab, else a new tab; a new space if Herdr closed the
 * space with it) and, for an agent, the same kind is started under the same name, resuming its session
 * when Herdr stored one.
 */
export async function reopenTab(deps: ManageDeps, closed: ClosedTab) {
  if (!(await deps.ensureConnected())) {
    return;
  }
  const spaces = deps.spaces();
  if (!closed.closedInHerdr) {
    for (const space of spaces) {
      const pane = space.tabs.flatMap((t) => t.panes).find((p) => p.id === closed.paneId);
      if (pane) {
        await deps.attach(space, pane);
        return;
      }
    }
  }
  // Ids change when Herdr restarts, so fall back to the name and folder.
  const space = spaces.find((s) => s.id === closed.space.id) ?? spaces.find((s) => s.label === closed.space.label && s.cwd === closed.space.cwd);
  const where = space?.label ?? closed.space.label;
  const cwd = closed.cwd ?? closed.space.cwd;
  // An agent started from a profile comes back with its variables (recognized by its name, or the account it ran in).
  let profile: AgentProfile | undefined;
  if (closed.agentKind) {
    const rows = deps.agentProfiles();
    profile = profileOfAgent(rows, closed.agentName) ?? rows.find((p) => !p.plain && p.name === closed.agentRow && p.kind === closed.agentKind);
  }
  const env = profile && { env: profile.env };
  try {
    let paneId: string;
    if (!space) {
      const r = await deps.actions.createSpace({ cwd: closed.space.cwd ?? cwd, label: closed.space.label, ...env });
      paneId = r.pane.pane_id;
      if (closed.tabLabel) {
        await deps.actions.renameTab(r.tab.tab_id, closed.tabLabel).catch(() => undefined);
      }
    } else {
      // The last snapshot may still list the closed pane itself.
      const sibling = space.tabs.find((t) => t.id === closed.tabId)?.panes.find((p) => p.id !== closed.paneId);
      if (sibling) {
        paneId = (await deps.actions.splitPane({ target_pane_id: sibling.id, direction: 'right', cwd, ...env })).pane_id;
      } else {
        paneId = (await deps.actions.createTab({ workspace_id: space.id, cwd, label: closed.tabLabel, ...env })).pane.pane_id;
      }
    }
    if (closed.paneLabel) {
      await deps.actions.renamePane(paneId, closed.paneLabel).catch(() => undefined);
    }
    const hit = await deps.findPane(paneId);
    if (!hit) {
      vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: the new tab was created but hasn't shown up yet. Click Refresh in the sidebar's ⋯ menu, then click it there.`);
      return;
    }
    await deps.attach(hit.space, hit.pane, closed.agentKind);
    if (closed.agentKind) {
      const taken = deps.agentNames();
      let name = closed.agentName;
      // A row found by its account (the agent had Herdr's plain name): named after the row now, so it's recognized.
      const rowLost = !!profile && !profileOfAgent(deps.agentProfiles(), name);
      if (!name || taken.includes(name) || rowLost) {
        name = agentName(profile?.slug ?? closed.agentKind, taken);
      }
      startAgent(deps, paneId, closed.agentKind, where, { name, args: resumeArgs(closed.agentKind, closed.session), profile });
    }
  } catch (e) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't reopen the tab in ${where}: ${err(e)}`);
  }
}

/**
 * New space: in a recent folder or one you pick, or on a worktree (a new one, or one on disk without a space). With
 * `folder` (e.g. this window's), the space goes there without asking where.
 */
export async function newSpace(deps: ManageDeps, folder?: string) {
  if (!(await deps.ensureConnected())) return;
  const title = 'New space';
  let dirPath = folder;
  if (!dirPath) {
    // The "+" beside Spaces: a folder, or a worktree (a new one, or one on disk that has no space).
    const where = await pickSpaceOrFolder(deps);
    if (where?.newWorktree) {
      await newWorktree(deps);
      return;
    }
    if (where?.worktree) {
      await openClosedWorktree(deps, where.worktree);
      return;
    }
    dirPath = where?.dir;
  }
  if (!dirPath) return;
  const dir = dirPath;
  const name = await vscode.window.showInputBox({ title, prompt: 'Space name', value: path.basename(dir), validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
  if (!name?.trim()) return;
  const label = name.trim();
  const what = await pickWhat(deps, `Start in "${label}"`);
  if (!what) return;
  await createAndOpen(deps, label, what, () => deps.actions.createSpace({ cwd: dir, label, ...(what.profile && { env: what.profile.env }) }));
}

/** Create a space, name its first tab after what runs in it, and open it like any new pane. */
async function createAndOpen(deps: ManageDeps, label: string, what: What, create: () => Promise<{ pane: { pane_id: string } }>, doing = 'Creating') {
  try {
    const { pane } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${doing} space "${label}"…` },
      create,
    );
    if (what.label || what.kind) {
      // Name the first tab after what runs in it, like a new tab.
      const hit = await deps.findPane(pane.pane_id);
      if (hit) {
        await deps.actions.renameTab(hit.pane.tabId, tabLabelFor(what)!).catch(() => undefined);
      }
    }
    await openCreated(deps, pane.pane_id, what, label);
  } catch (e) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't create the space: ${err(e)}`);
  }
}

/** The spaces new worktrees can start from: each repo once, from its own space (not another worktree's). */
function repoSpaces(deps: ManageDeps): Space[] {
  const repos: Space[] = [];
  for (const s of deps.spaces()) {
    const repo = repoSpace(deps.spaces(), s);
    if (repo && repo.cwd && deps.branchOf(repo.cwd) && !repos.includes(repo)) {
      repos.push(repo);
    }
  }
  return repos;
}

/** The repo a new worktree comes from when none was clicked: the one open in this window, the only one, or ask. */
async function pickRepo(deps: ManageDeps): Promise<Space | undefined> {
  const repos = repoSpaces(deps);
  if (!repos.length) {
    vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: no space is a git repository yet. Create a space on your repo's folder first (the + next to Spaces).`);
    return undefined;
  }
  const here = repos.filter((s) => deps.isOpenHere(s));
  if (here.length === 1) {
    return here[0];
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const ordered = [...here, ...repos.filter((s) => !here.includes(s))];
  const pick = await vscode.window.showQuickPick(
    ordered.map((s) => ({ label: s.label, description: s.cwd, iconPath: new vscode.ThemeIcon('repo'), s })),
    { title: 'New worktree', placeHolder: 'Which repository?' },
  );
  return pick?.s;
}

/** What a new worktree space starts with (herdr.newWorktreeStartsWith): a shell, an agent, or ask. */
async function worktreeStart(deps: ManageDeps, label: string): Promise<What | undefined> {
  const start = vscode.workspace.getConfiguration('herdr').get<string>('newWorktreeStartsWith', 'shell');
  if (start === 'ask') {
    return pickWhat(deps, `Start in "${label}"`);
  }
  if (start === 'shell' || !start) {
    return {};
  }
  return { kind: start };
}

/**
 * A new space on a new git worktree of a repo, for one piece of work (a ticket): one question, the branch name
 * (a ticket key or its link works too). The branch starts from the repo's main branch, not from whatever branch
 * its space has checked out, so it doesn't carry another ticket's unfinished work. `from` is the space clicked;
 * a worktree space stands for its repo.
 */
export async function newWorktree(deps: ManageDeps, from?: Space) {
  if (!(await deps.ensureConnected())) return;
  let repo: Space | undefined;
  if (from) {
    repo = repoSpace(deps.spaces(), from);
    if (!repo) {
      vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: "${from.label}" is a worktree whose repository has no space here. Open the repository's own space first.`);
      return;
    }
  } else {
    repo = await pickRepo(deps);
  }
  if (!repo?.cwd) {
    return;
  }
  const base = await deps.mainBranch(repo.cwd);
  let startsFrom = `It starts from ${deps.branchOf(repo.cwd) ?? 'the current branch'}.`;
  if (base) {
    startsFrom = `It starts from your local ${base} (pull it first if it's behind).`;
  }
  const typed = await vscode.window.showInputBox({
    title: `New worktree of ${repo.label}`,
    prompt: `A branch name, a ticket key or the ticket's link. ${startsFrom}`,
    placeHolder: 'e.g. OUT-9656 or feat/rate-limit',
    validateInput: (v) => branchProblem(branchFromInput(v)),
  });
  if (typed === undefined) return;
  const branch = branchFromInput(typed);
  if (branchProblem(branch)) return;
  const what = await worktreeStart(deps, branch);
  if (!what) return;
  const repoId = repo.id;
  await createAndOpen(deps, branch, what, async () => {
    let created: Awaited<ReturnType<BackendActions['createWorktreeSpace']>>;
    if (base) {
      created = await deps.actions.createWorktreeSpace({ workspace_id: repoId, branch, label: branch, base });
    } else {
      created = await deps.actions.createWorktreeSpace({ workspace_id: repoId, branch, label: branch });
    }
    return withProfileTab(deps, what, created.workspace.workspace_id, created.worktree.path, created.pane.pane_id);
  });
}

/**
 * worktree.create and worktree.open take no variables: a profile's agent gets a tab of its own that has them, in
 * place of the plain first pane (closed only once the new tab exists, or Herdr would close the space with it).
 */
async function withProfileTab(deps: ManageDeps, what: What, spaceId: string, cwd: string, firstPaneId: string): Promise<{ pane: { pane_id: string } }> {
  if (!what.profile) {
    return { pane: { pane_id: firstPaneId } };
  }
  const tab = await deps.actions.createTab({ workspace_id: spaceId, cwd, env: what.profile.env });
  await deps.actions.closePane(firstPaneId).catch(() => undefined);
  return tab;
}

/** The worktrees that exist on disk but have no space, from every repo Herdr knows (or only `from`'s). */
function findClosedWorktrees(deps: ManageDeps, from?: Space): Promise<{ found: ClosedWorktree[]; failed: number }> {
  return findWorktrees(deps, from, false);
}

/** The worktrees on disk of every repo Herdr knows (or only `from`'s): with `all`, also the ones that have a space. */
async function findWorktrees(deps: ManageDeps, from: Space | undefined, all: boolean): Promise<{ found: ClosedWorktree[]; failed: number }> {
  // Each entry: the folders to try in turn until worktree.list answers (one repo's checkouts), and whether it's
  // known to be a repository (a failure there is worth saying; a space on a plain folder just has nothing).
  let groups: { folders: string[]; repo: boolean }[];
  if (from?.cwd) {
    groups = [{ folders: [from.cwd], repo: true }];
  } else {
    const repos = herdrWorktreeRepos(os.homedir());
    const spaces = deps.spaces();
    const folders = worktreeListFolders(
      spaces,
      repos.map((r) => r[0]),
    );
    const checkoutsOf = new Map(repos.map((r) => [r[0], r] as const));
    groups = folders.map((f) => {
      // A space's own folder first: a repo when Herdr says the space is part of one.
      const space = spaces.find((sp) => sp.cwd === f);
      if (space) {
        return { folders: [f], repo: !!space.worktree };
      }
      // Herdr's folder of a repo, tried checkout by checkout. Not counted when it fails: a leftover folder of a
      // repo that's gone fails every time.
      return { folders: checkoutsOf.get(f) ?? [f], repo: false };
    });
  }
  const listFrom = async (group: { folders: string[]; repo: boolean }) => {
    for (const cwd of group.folders) {
      try {
        return await deps.actions.listWorktrees({ cwd });
      } catch (e) {
        if (group.repo) {
          deps.log(`worktree.list from ${cwd}: ${err(e)}`);
        }
      }
    }
    return undefined;
  };
  // 6 at a time, like every other batch of Herdr requests: each runs git in Herdr.
  const lists: Awaited<ReturnType<typeof listFrom>>[] = [];
  for (let i = 0; i < groups.length; i += 6) {
    lists.push(...(await Promise.all(groups.slice(i, i + 6).map(listFrom))));
  }
  const failed = groups.filter((g, i) => g.repo && lists[i] === undefined).length;
  const answered = lists.filter((l) => l !== undefined);
  if (all) {
    return { found: linkedWorktrees(answered), failed };
  }
  return { found: closedWorktrees(answered), failed };
}

/**
 * A space again for a worktree that's still on disk but not in the sidebar (its space was closed in Herdr, or
 * Herdr restarted without it): pick it from every repo's worktrees, or `from`'s repo. It starts like a new
 * worktree (herdr.newWorktreeStartsWith).
 */
export async function reopenWorktree(deps: ManageDeps, from?: Space) {
  if (!(await deps.ensureConnected())) {
    return;
  }
  const { found, failed } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking for closed worktrees…' }, () =>
    findClosedWorktrees(deps, from),
  );
  // A worktree card stands for its repo.
  let repoName = from?.label;
  if (from?.worktree?.is_linked_worktree) {
    repoName = from.worktree.repo_name;
  }
  if (!found.length) {
    let where = 'Every worktree Herdr knows already has a space.';
    if (repoName) {
      where = `Every worktree of ${repoName} already has a space.`;
    }
    if (failed) {
      // Some repos didn't answer: don't claim there's nothing.
      where = `Herdr couldn't list the worktrees of ${failed} folder(s); the ${EXTENSION_NAME} output shows why.`;
    }
    vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: no closed worktree to reopen. ${where}`);
    return;
  }
  let title = 'Reopen worktree';
  if (repoName) {
    title = `Reopen a worktree of ${repoName}`;
  }
  let placeHolder = 'Which worktree? It opens as a space again, files as you left them';
  if (failed) {
    // Some repos didn't answer: this list may be missing their worktrees.
    placeHolder = `Which worktree? (Herdr couldn't list ${failed} folder(s); the ${EXTENSION_NAME} output shows why)`;
  }
  const pick = await vscode.window.showQuickPick(worktreeItems(found), { title, placeHolder, matchOnDetail: true });
  if (pick?.w) {
    await openClosedWorktree(deps, pick.w);
  }
}

type WorktreeItem = vscode.QuickPickItem & { w?: ClosedWorktree; create?: boolean };

/** One pick item per closed worktree, under a separator per repo when there are several. */
function worktreeItems(found: ClosedWorktree[]): WorktreeItem[] {
  const items: WorktreeItem[] = [];
  const repos = new Set(found.map((w) => w.repoFolder));
  for (const w of found) {
    const prev = items.at(-1);
    if (repos.size > 1 && prev?.w?.repoFolder !== w.repoFolder) {
      items.push({ label: w.repoName, kind: vscode.QuickPickItemKind.Separator });
    }
    // The label is the branch already: the description only adds what it doesn't say.
    let description: string | undefined;
    if (!w.branch) {
      description = 'detached';
    } else if (path.basename(w.path) !== worktreeLabel(w)) {
      description = path.basename(w.path);
    }
    items.push({ label: worktreeLabel(w), description, detail: tildePath(w.path), iconPath: new vscode.ThemeIcon('repo-forked'), w });
  }
  return items;
}

/** A space for a worktree that's on disk without one, named after its branch, started like a new worktree. */
async function openClosedWorktree(deps: ManageDeps, w: ClosedWorktree) {
  const label = worktreeLabel(w);
  const what = await worktreeStart(deps, label);
  if (!what) {
    return;
  }
  await createAndOpen(deps, label, what, async () => {
    const opened = await deps.actions.openWorktreeSpace({ cwd: w.repoFolder, path: w.path, label });
    const spaceId = opened.workspace.workspace_id;
    const space = await deps.findSpace(spaceId);
    const first = space?.tabs[0]?.panes[0];
    if (!first) {
      throw new Error(`Herdr opened ${spaceId} but it hasn't appeared yet. Refresh and click it in the sidebar`);
    }
    return withProfileTab(deps, what, spaceId, w.path, first.id);
  }, 'Opening');
}

/**
 * The branch button on a repository's card: every worktree of that repo, open or not, with what it holds
 * (uncommitted changes, commits the main branch doesn't have). Picking one goes to its space, or opens one for it;
 * its trash button deletes it. New worktree… comes first when the repo has its own space.
 */
export async function worktreeMenu(deps: ManageDeps, from?: Space) {
  if (!from?.cwd) {
    await newWorktree(deps, from);
    return;
  }
  if (!(await deps.ensureConnected())) {
    return;
  }
  // A worktree card stands for its repo.
  let repoName = from.label;
  if (from.worktree?.is_linked_worktree) {
    repoName = from.worktree.repo_name;
  }
  type Item = vscode.QuickPickItem & { w?: ClosedWorktree; create?: boolean };
  const DELETE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete this worktree…' };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Worktrees of ${repoName}`;
  qp.placeholder = 'Looking for worktrees…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  const top: Item[] = [];
  // New needs the repo's own space; without it, only the worktrees on disk are offered.
  if (repoSpace(deps.spaces(), from)) {
    top.push({ label: 'New worktree…', description: 'a new branch and checkout', iconPath: new vscode.ThemeIcon('git-branch-create'), create: true });
  }
  qp.items = top;
  const chosen = new Promise<{ item?: Item; remove?: boolean }>((resolve) => {
    qp.onDidAccept(() => resolve({ item: qp.selectedItems[0] }));
    qp.onDidTriggerItemButton((e) => resolve({ item: e.item, remove: true }));
    qp.onDidHide(() => resolve({}));
  });
  qp.show();

  const { found, failed } = await findWorktrees(deps, from, true);
  const spaces = deps.spaces();
  const items: Item[] = [...top, { label: 'Worktrees', kind: vscode.QuickPickItemKind.Separator }];
  const shown = (states: (WorktreeState | undefined)[]) => {
    const rows: Item[] = found.map((w, i) => worktreeRow(w, spaces, states[i], deps.isOpenHere));
    if (!rows.length && !failed) {
      // Said in the list rather than skipping it, so the button always does the same thing. Picking it does nothing.
      rows.push({ label: 'No worktree yet', description: 'New worktree… makes one', iconPath: new vscode.ThemeIcon('info') });
    }
    return [...items, ...rows.map((r): Item => {
      if (r.w) {
        return { ...r, buttons: [DELETE] };
      }
      return r;
    })];
  };
  qp.items = shown([]);
  qp.placeholder = 'Pick one to go to it (or open it again); the trash button deletes it';
  if (failed) {
    qp.placeholder = `Herdr couldn't list this repository's worktrees; the ${EXTENSION_NAME} output shows why`;
  }
  // What each holds comes from git, after the list is up (several checkouts take a moment).
  const base = await deps.mainBranch(found[0]?.repoFolder ?? from.cwd);
  const states: (WorktreeState | undefined)[] = [];
  for (let i = 0; i < found.length; i += 6) {
    states.push(...(await Promise.all(found.slice(i, i + 6).map((w) => deps.worktreeState(w.path, base).catch(() => undefined)))));
  }
  // Keep what's typed and the highlighted row: replacing the items would move it back to the top.
  const active = qp.activeItems[0]?.w?.path;
  qp.items = shown(states);
  const again = qp.items.find((i) => active && i.w?.path === active);
  if (again) {
    qp.activeItems = [again];
  }
  qp.busy = false;

  const { item, remove } = await chosen;
  qp.dispose();
  if (item?.create) {
    await newWorktree(deps, from);
    return;
  }
  const w = item?.w;
  if (!w) {
    return;
  }
  const state = states[found.indexOf(w)];
  if (remove) {
    if (await deleteWorktree(deps, w, state, base)) {
      // Back to the list, so several can go one after the other.
      await worktreeMenu(deps, from);
    }
    return;
  }
  const space = spaces.find((sp) => sp.id === w.spaceId);
  if (space) {
    await deps.switchTo(space);
  } else {
    await openClosedWorktree(deps, w);
  }
}

/** One worktree in the list: its branch, where its space is, and what it holds. */
function worktreeRow(w: ClosedWorktree, spaces: Space[], state: WorktreeState | undefined, isOpenHere: (s: Space) => boolean): vscode.QuickPickItem & { w: ClosedWorktree } {
  const space = spaces.find((sp) => sp.id === w.spaceId);
  let where = 'no space: picking it opens one';
  if (space && isOpenHere(space)) {
    where = 'open in this window';
  } else if (space) {
    where = 'has a space';
  }
  let icon = 'folder';
  if (space) {
    icon = 'repo-forked';
  }
  const parts = [where];
  if (!w.branch) {
    parts.push('detached');
  }
  return {
    label: worktreeLabel(w),
    description: parts.join(' · '),
    detail: [tildePath(w.path), holds(state)].filter(Boolean).join(' · '),
    iconPath: new vscode.ThemeIcon(icon),
    w,
  };
}

/** "1 commit", "3 commits". */
function counted(n: number, word: string): string {
  if (n === 1) {
    return `1 ${word}`;
  }
  return `${n} ${word}s`;
}

/** "3 uncommitted files · 2 commits not in main", "nothing beyond main", or nothing while git hasn't answered. */
function holds(state: WorktreeState | undefined): string {
  if (!state) {
    return '';
  }
  const parts: string[] = [];
  if (state.changes) {
    parts.push(counted(state.changes, 'uncommitted file'));
  }
  if (state.ahead) {
    parts.push(`${counted(state.ahead, 'commit')} not in the main branch`);
  }
  if (!parts.length && state.ahead === 0) {
    return 'nothing beyond the main branch';
  }
  if (!parts.length) {
    return 'no uncommitted changes';
  }
  return parts.join(' · ');
}

/**
 * Deletes a worktree's folder (its space too, when it has one), after confirming. Herdr deletes worktrees only
 * through their space (worktree.remove takes a space), so one without a space gets one first, closed again when
 * the delete doesn't happen. The branch itself stays in the repository. True when it was deleted.
 */
async function deleteWorktree(deps: ManageDeps, w: ClosedWorktree, state: WorktreeState | undefined, base: string | undefined): Promise<boolean> {
  const label = worktreeLabel(w);
  const lost: string[] = [];
  if (state?.changes) {
    lost.push(`${counted(state.changes, 'uncommitted file')} will be lost.`);
  }
  if (state?.ahead && w.branch) {
    lost.push(`Its ${counted(state.ahead, 'commit')} not in ${base} stay on the branch ${w.branch}.`);
  }
  let stops = '';
  const space = deps.spaces().find((sp) => sp.id === w.spaceId);
  if (space) {
    stops = ` Its space "${space.label}" closes and everything running in it stops.`;
  }
  let detail = `This deletes the folder ${tildePath(w.path)}.${stops} The branch stays in the repository.`;
  if (lost.length) {
    detail += `\n\n${lost.join(' ')}`;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete the worktree "${label}"?`,
    { modal: true, detail },
    'Delete Worktree',
  );
  if (!ok) {
    return false;
  }
  let spaceId = w.spaceId;
  let openedForIt = false;
  try {
    if (!spaceId) {
      const opened = await deps.actions.openWorktreeSpace({ cwd: w.repoFolder, path: w.path, label });
      spaceId = opened.workspace.workspace_id;
      openedForIt = !opened.already_open;
    }
    await deps.actions.removeWorktree(spaceId, (state?.changes ?? 0) > 0);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: the worktree "${label}" wasn't deleted: ${err(e)}`);
    if (openedForIt && spaceId) {
      await deps.actions.closeSpace(spaceId).catch(() => undefined);
    }
    return false;
  }
}

/**
 * Where a new space lives: one of the folders opened recently in the editor (`_workbench.getRecentlyOpened`, VS
 * Code's own list), one you choose, a new worktree, or a worktree on disk that has no space.
 */
async function pickSpaceOrFolder(deps: ManageDeps): Promise<{ dir?: string; worktree?: ClosedWorktree; newWorktree?: boolean } | undefined> {
  type Item = vscode.QuickPickItem & { dir?: string; worktree?: ClosedWorktree; newWorktree?: boolean; choose?: boolean };
  const title = 'New space';
  const spaceFolders = deps.spaces().flatMap((s) => {
    if (s.cwd) {
      return [s.cwd];
    }
    return [];
  });
  const recent = recentFolders(await editorRecentFolders(deps), spaceFolders, os.homedir());
  const items: Item[] = [
    { label: 'Choose a folder…', iconPath: new vscode.ThemeIcon('folder-opened'), detail: 'The space opens in that folder', choose: true },
  ];
  // A worktree needs a repository that has its own space (New worktree… asks which, when there are several).
  if (repoSpaces(deps).length) {
    items.push({ label: 'New worktree…', iconPath: new vscode.ThemeIcon('git-branch-create'), detail: 'A new branch and checkout of one of your repositories', newWorktree: true });
  }
  if (recent.length) {
    items.push({ label: 'Recent folders', kind: vscode.QuickPickItemKind.Separator });
    for (const dir of recent) {
      items.push({ label: path.basename(dir), description: tildePath(path.dirname(dir)), iconPath: new vscode.ThemeIcon('folder'), dir });
    }
  }
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = title;
  qp.placeholder = 'A folder or a worktree for the new space';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = items;
  qp.busy = true;
  const chosen = new Promise<Item | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  qp.show();
  // Worktrees on disk without a space, from every repo Herdr knows: asking each takes a moment, so they come after.
  void findClosedWorktrees(deps)
    .then(({ found }) => {
      if (!found.length) {
        return;
      }
      const active = qp.activeItems[0];
      const rows: Item[] = worktreeItems(found).map((i) => {
        if (i.w) {
          return { ...i, worktree: i.w };
        }
        return i;
      });
      qp.items = [...items, { label: 'Worktrees without a space', kind: vscode.QuickPickItemKind.Separator }, ...rows];
      // Replacing the items moves the highlight back to the top: keep it where it was.
      if (active) {
        qp.activeItems = [active];
      }
    })
    .catch((e) => deps.log(`closed worktrees: ${err(e)}`))
    .finally(() => {
      qp.busy = false;
    });
  const where = await chosen;
  qp.dispose();
  if (!where) return;
  if (where.worktree) {
    return { worktree: where.worktree };
  }
  if (where.newWorktree) {
    return { newWorktree: true };
  }
  if (where.dir) {
    return { dir: where.dir };
  }
  if (!where.choose) return;
  const near = deps.spaces().find((s) => s.cwd)?.cwd;
  const [dir] =
    (await vscode.window.showOpenDialog({
      title,
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use this folder',
      defaultUri: vscode.Uri.file(near ? path.dirname(near) : os.homedir()),
    })) ?? [];
  if (!dir) return;
  return { dir: dir.fsPath };
}

/** The editor's recently opened local folders, newest first (an internal command: empty if it isn't there). */
async function editorRecentFolders(deps: ManageDeps): Promise<string[]> {
  try {
    const recent = await vscode.commands.executeCommand<{ workspaces?: Array<{ folderUri?: vscode.Uri }> }>('_workbench.getRecentlyOpened');
    const folders: string[] = [];
    for (const w of recent?.workspaces ?? []) {
      if (!w.folderUri) {
        continue;
      }
      const uri = vscode.Uri.from(w.folderUri);
      if (uri.scheme === 'file') {
        folders.push(uri.fsPath);
      }
    }
    return folders;
  } catch (e) {
    deps.log(`recent folders: ${err(e)}`);
    return [];
  }
}

/** Rename a space, or a pane (shells: the pane label; agents: the agent's name). */
export async function rename(deps: ManageDeps, target: { space: Space; pane?: Pane }) {
  const { space, pane } = target;
  if (!pane) {
    const label = await vscode.window.showInputBox({ title: 'Rename space', value: space.label, validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
    if (!label?.trim()) return;
    await deps.actions.renameSpace(space.id, label.trim()).catch((e) => vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't rename "${space.label}": ${err(e)}`));
    return;
  }
  const tab = space.tabs.find((t) => t.id === pane.tabId);
  const current = paneName(tab, pane);
  const value = await vscode.window.showInputBox({
    title: `Rename ${current}`,
    // Herdr agent names are identifiers (they're also CLI targets).
    value: pane.isAgent ? (pane.raw.agent?.name ?? pane.agentKind ?? '') : current,
    prompt: pane.isAgent ? 'Agent name: lowercase letters, digits, - or _ (e.g. reviewer)' : 'Shell name (leave empty to use the tab name)',
    validateInput: (v) => (pane.isAgent && v.trim() && !AGENT_NAME.test(v.trim()) ? 'Use lowercase letters, digits, - or _, starting with a letter' : undefined),
  });
  if (value === undefined) return;
  const name = value.trim() || null;
  try {
    if (pane.isAgent) {
      await deps.actions.renameAgent(pane.id, name);
    } else {
      await deps.actions.renamePane(pane.id, name);
    }
    // The VS Code tab carries the same name.
    const updated = await deps.findPane(pane.id);
    if (updated) await deps.renameTerminal(pane.id, tabName(updated.space.tabs.find((t) => t.id === pane.tabId), updated.pane));
  } catch (e) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't rename ${current}: ${err(e)}`);
  }
}

/** Close a pane (or its tab, when it's the only pane) or a whole space in Herdr, after confirming. */
export async function closeInHerdr(deps: ManageDeps, target: { space: Space; pane?: Pane }) {
  const { space, pane } = target;
  if (!pane) {
    const panes = space.tabs.flatMap((t) => t.panes);
    const agents = panes.filter((p) => p.isAgent).length;
    const what = [agents && `${agents} agent${agents > 1 ? 's' : ''}`, panes.length - agents && `${panes.length - agents} shell${panes.length - agents > 1 ? 's' : ''}`]
      .filter(Boolean)
      .join(' and ');
    const worktree = space.worktree?.is_linked_worktree;
    const ok = await vscode.window.showWarningMessage(
      `Close the space "${space.label}"${inDriver(deps.capabilities)}?`,
      {
        modal: true,
        detail: `${what || 'Everything'} in it will stop.${
          worktree ? ` It's a git worktree at ${space.cwd}: "Close Space" keeps that folder, "Close and Delete Worktree" removes it (Herdr refuses if it has uncommitted changes).` : ' Files on disk are not touched.'
        }`,
      },
      'Close Space',
      ...(worktree ? ['Close and Delete Worktree'] : []),
    );
    if (!ok) return;
    if (ok === 'Close and Delete Worktree') return removeWorktree(deps, space);
    try {
      await deps.actions.closeSpace(space.id);
    } catch (e: any) {
      if (e?.code !== 'workspace_group_close_required') {
        return void vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't close "${space.label}": ${err(e)}`);
      }
      const all = await vscode.window.showWarningMessage(
        `"${space.label}" has worktree spaces.`,
        { modal: true, detail: 'Herdr closes a space together with its worktree spaces. Their worktree folders stay on disk.' },
        'Close All',
      );
      if (all) {
        await deps.actions.closeSpace(space.id, true).catch((e2) => vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't close "${space.label}" and its worktree spaces: ${err(e2)}`));
      }
    }
    return;
  }
  const tab = space.tabs.find((t) => t.id === pane.tabId);
  const name = paneName(tab, pane);
  let what = 'The shell and anything running in it';
  if (pane.isAgent) {
    what = 'The agent';
  }
  const ok = await vscode.window.showWarningMessage(
    `Close "${name}"${inDriver(deps.capabilities)}?`,
    { modal: true, detail: `${what} will stop. Closing the VS Code tab instead keeps it running${keptWhere(deps)}.` },
    'Close',
  );
  if (!ok) return;
  const only = !tab || tab.panes.length <= 1;
  await (only && tab ? deps.actions.closeTab(tab.id) : deps.actions.closePane(pane.id)).catch((e) =>
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't close "${name}": ${err(e)}`),
  );
}

/** Where a pane keeps running when only its tab closes. */
function keptWhere(deps: ManageDeps): string {
  if (deps.capabilities.server) {
    return inDriver(deps.capabilities);
  }
  return ' in this window';
}

/** Delete a worktree space and its folder; offers to force it when there are uncommitted changes. */
async function removeWorktree(deps: ManageDeps, space: Space) {
  try {
    await deps.actions.removeWorktree(space.id);
  } catch (e) {
    const force = await vscode.window.showWarningMessage(
      `The worktree "${space.label}" wasn't deleted.`,
      { modal: true, detail: `${err(e)}\n\nDelete it anyway? Uncommitted changes in ${space.cwd} will be lost.` },
      'Delete Anyway',
    );
    if (force) {
      await deps.actions.removeWorktree(space.id, true).catch((e2) => vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't delete the worktree "${space.label}": ${err(e2)}`));
    }
  }
}
