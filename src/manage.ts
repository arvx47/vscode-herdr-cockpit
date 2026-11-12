// Creating, renaming and closing Herdr spaces and tabs from VS Code: the quick picks, input boxes
// and confirmations around src/herdrActions.ts. Every new pane opens straight away in a terminal tab.
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { AGENT_KINDS, AGENT_NAME, agentName, agentTitle, HerdrActions, resumeArgs } from './herdrActions';
import { errorText } from './herdrClient';
import type { AgentSessionInfo } from './herdrTypes';
import { repoSpace } from './model';
import type { Pane, Space } from './model';
import { paneName, tabName } from './viewState';
import { branchFromInput, branchProblem } from './branchName';

/** What a new tab runs: a plain shell, or an agent kind ("claude", "codex", ...). */
export interface What {
  kind?: string;
  /** Herdr tab label; empty = Herdr numbers the tab ("Tab 7"). */
  label?: string;
}

export interface ManageDeps {
  actions: HerdrActions;
  /** Re-reads the snapshot until the pane shows up (it normally does right away). */
  findPane(paneId: string): Promise<{ space: Space; pane: Pane } | undefined>;
  /** Opens the pane in a terminal tab (switching to its space first, like clicking its row). */
  attach(space: Space, pane: Pane, startingAs?: string): Promise<void>;
  agentIcon(kind?: string): vscode.QuickPickItem['iconPath'];
  /** Current spaces, for "new worktree of …". */
  spaces(): Space[];
  /** Current git branch of a folder, when it is a repository. */
  branchOf(cwd?: string): string | undefined;
  /** The branch new worktrees start from (gitInfo.ts mainBranch()); undefined when git can't say. */
  mainBranch(cwd: string): Promise<string | undefined>;
  /** The space is open in this window (its folder is one of this window's). */
  isOpenHere(space: Space): boolean;
  /** Agent names in use (agent names must be unique). */
  agentNames(): string[];
  /** Agents listed first when choosing (setting herdr.agents). */
  agents(): string[];
  /** The agent kinds the running Herdr knows (its agent manifests); empty when it couldn't say. */
  herdrAgentKinds(): Promise<string[]>;
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
  type Item = vscode.QuickPickItem & { what?: What; more?: boolean; named?: boolean };
  const known = await knownKinds(deps);
  const favorites = deps.agents().filter((k) => known.includes(k));
  const agentItem = (kind: string): Item => ({ label: agentTitle(kind), description: kind, iconPath: deps.agentIcon(kind) ?? new vscode.ThemeIcon('hubot'), what: { kind } });
  const items: Item[] = [
    { label: 'Shell', iconPath: new vscode.ThemeIcon('terminal'), what: {} },
    { label: 'Shell with a name…', iconPath: new vscode.ThemeIcon('edit'), named: true },
    { label: 'Agents', kind: vscode.QuickPickItemKind.Separator },
    ...favorites.map(agentItem),
    { label: 'More agents…', iconPath: new vscode.ThemeIcon('ellipsis'), more: true },
  ];
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'What should the new tab run?' });
  if (!pick) return;
  if (pick.named) {
    const label = await vscode.window.showInputBox({ title, prompt: 'Tab name', placeHolder: 'e.g. dev server' });
    return label?.trim() ? { label: label.trim() } : undefined;
  }
  if (pick.more) {
    const kind = await pickAgent(deps, title, favorites, known);
    return kind ? { kind } : undefined;
  }
  return pick.what;
}

/** Any agent Herdr can start, except `skip`. Undefined if cancelled. */
export async function pickAgent(deps: ManageDeps, title: string, skip: string[] = [], known?: string[]): Promise<string | undefined> {
  known ??= await knownKinds(deps);
  const items = known
    .filter((k) => !skip.includes(k))
    .map((agent) => ({ label: agentTitle(agent), description: agent, iconPath: deps.agentIcon(agent) ?? new vscode.ThemeIcon('hubot'), agent }));
  return (await vscode.window.showQuickPick(items, { title, placeHolder: 'Agent to start' }))?.agent;
}

/**
 * Start an agent in a fresh pane, in the background: the tab is already open, so you watch it
 * launch. Herdr waits until the agent is ready for input.
 */
export function startAgent(deps: ManageDeps, paneId: string, kind: string, where: string, opts: { name?: string; args?: string[] } = {}) {
  const name = agentTitle(kind);
  let verb = 'Starting';
  if (opts.args?.length) {
    verb = 'Resuming';
  }
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${verb} ${name} in ${where}…` },
    async () => {
      try {
        await deps.actions.startAgent(paneId, kind, opts.name ?? agentName(kind, deps.agentNames()), opts.args);
      } catch (e) {
        deps.log(`agent.start ${kind} in ${paneId}: ${err(e)}`);
        vscode.window.showErrorMessage(`Herdr: couldn't start ${name}: ${err(e)}`);
      }
    },
  );
}

/** Opens a pane Herdr just created, then starts its agent if one was chosen. */
async function openCreated(deps: ManageDeps, paneId: string, what: What, where: string) {
  const hit = await deps.findPane(paneId);
  if (!hit) {
    vscode.window.showWarningMessage(`Herdr created ${paneId} but it hasn't appeared yet. Refresh and click it in the sidebar.`);
    return;
  }
  await deps.attach(hit.space, hit.pane, what.kind);
  if (what.kind) startAgent(deps, hit.pane.id, what.kind, where);
}

export async function newTab(deps: ManageDeps, space: Space, what?: What) {
  if (!(await deps.ensureConnected())) return;
  what ??= await pickWhat(deps, `New tab in ${space.label}`);
  if (!what) return;
  try {
    const { pane } = await deps.actions.createTab({
      workspace_id: space.id,
      cwd: space.cwd,
      label: what.label ?? (what.kind ? agentTitle(what.kind) : undefined),
    });
    await openCreated(deps, pane.pane_id, what, space.label);
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: couldn't create a tab in ${space.label}: ${err(e)}`);
  }
}

/** Split a pane: a new pane next to it in the same Herdr tab, running a shell or an agent you pick. */
export async function splitPane(deps: ManageDeps, space: Space, pane: Pane) {
  if (!(await deps.ensureConnected())) return;
  const name = paneName(space.tabs.find((t) => t.id === pane.tabId), pane);
  const what = await pickWhat(deps, `Split ${name} (${space.label})`);
  if (!what) return;
  try {
    const created = await deps.actions.splitPane({ target_pane_id: pane.id, direction: 'right', cwd: pane.cwd ?? space.cwd });
    // "Shell with a name…" names the new pane (its Herdr tab keeps its name).
    if (what.label) {
      await deps.actions.renamePane(created.pane_id, what.label).catch(() => undefined);
    }
    await openCreated(deps, created.pane_id, what, space.label);
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: couldn't split ${name}: ${err(e)}`);
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
  /** The agent's own session, when Herdr stored one: reopening resumes it (resumeArgs()). */
  session?: AgentSessionInfo;
}

export function closedTab(space: Space, pane: Pane): ClosedTab {
  const tab = space.tabs.find((t) => t.id === pane.tabId);
  let tabLabel = tab?.label;
  // Herdr numbers unnamed tabs ("3"); a new tab gets its own number.
  if (tabLabel && /^\d+$/.test(tabLabel)) {
    tabLabel = undefined;
  }
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
  try {
    let paneId: string;
    if (!space) {
      const r = await deps.actions.createSpace({ cwd: closed.space.cwd ?? cwd, label: closed.space.label });
      paneId = r.pane.pane_id;
      if (closed.tabLabel) {
        await deps.actions.renameTab(r.tab.tab_id, closed.tabLabel).catch(() => undefined);
      }
    } else {
      // The last snapshot may still list the closed pane itself.
      const sibling = space.tabs.find((t) => t.id === closed.tabId)?.panes.find((p) => p.id !== closed.paneId);
      if (sibling) {
        paneId = (await deps.actions.splitPane({ target_pane_id: sibling.id, direction: 'right', cwd })).pane_id;
      } else {
        paneId = (await deps.actions.createTab({ workspace_id: space.id, cwd, label: closed.tabLabel })).pane.pane_id;
      }
    }
    if (closed.paneLabel) {
      await deps.actions.renamePane(paneId, closed.paneLabel).catch(() => undefined);
    }
    const hit = await deps.findPane(paneId);
    if (!hit) {
      vscode.window.showWarningMessage(`Herdr created ${paneId} but it hasn't appeared yet. Refresh and click it in the sidebar.`);
      return;
    }
    await deps.attach(hit.space, hit.pane, closed.agentKind);
    if (closed.agentKind) {
      const taken = deps.agentNames();
      let name = closed.agentName;
      if (!name || taken.includes(name)) {
        name = agentName(closed.agentKind, taken);
      }
      startAgent(deps, paneId, closed.agentKind, where, { name, args: resumeArgs(closed.agentKind, closed.session) });
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: couldn't reopen the tab in ${where}: ${err(e)}`);
  }
}

/**
 * New space: in a folder you pick, or on a new git worktree of an existing space's repo. With `folder` (e.g. this
 * window's), the space goes there without asking where.
 */
export async function newSpace(deps: ManageDeps, folder?: string) {
  if (!(await deps.ensureConnected())) return;
  const title = 'New space';
  let dirPath = folder;
  let from: Space | undefined;
  if (!dirPath) {
    const picked = await pickNewSpacePlace(deps, title);
    if (!picked) return;
    dirPath = picked.dir;
    from = picked.from;
  }

  if (!dirPath) {
    return newWorktree(deps, from);
  }
  const dir = dirPath;
  const name = await vscode.window.showInputBox({ title, prompt: 'Space name', value: path.basename(dir), validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
  if (!name?.trim()) return;
  const label = name.trim();
  const what = await pickWhat(deps, `Start in "${label}"`);
  if (!what) return;
  await createAndOpen(deps, label, what, () => deps.actions.createSpace({ cwd: dir, label }));
}

/** Create a space, name its first tab after what runs in it, and open it like any new pane. */
async function createAndOpen(deps: ManageDeps, label: string, what: What, create: () => Promise<{ pane: { pane_id: string } }>) {
  try {
    const { pane } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating space "${label}"…` },
      create,
    );
    if (what.label || what.kind) {
      // Name the first tab after what runs in it, like a new tab.
      const hit = await deps.findPane(pane.pane_id);
      if (hit) await deps.actions.renameTab(hit.pane.tabId, what.label ?? agentTitle(what.kind!)).catch(() => undefined);
    }
    await openCreated(deps, pane.pane_id, what, label);
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: couldn't create the space: ${err(e)}`);
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
    vscode.window.showInformationMessage('Herdr: no space is a git repository yet. Create a space on your repo\'s folder first (the + next to Spaces).');
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
      vscode.window.showWarningMessage(`Herdr: "${from.label}" is a worktree whose repository has no space here. Open the repository's own space first.`);
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
  await createAndOpen(deps, branch, what, () => {
    if (base) {
      return deps.actions.createWorktreeSpace({ workspace_id: repoId, branch, label: branch, base });
    }
    return deps.actions.createWorktreeSpace({ workspace_id: repoId, branch, label: branch });
  });
}

/** Where a new space goes: a folder you pick (`dir`), or a new worktree of a space's repo (`from`). */
async function pickNewSpacePlace(deps: ManageDeps, title: string): Promise<{ dir?: string; from?: Space } | undefined> {
  type Item = vscode.QuickPickItem & { folder?: boolean; from?: Space };
  // Herdr starts new worktrees from the repo's own space, not from another worktree's: offer each repo once.
  const repos = repoSpaces(deps);
  const items: Item[] = [
    { label: 'Choose a folder…', iconPath: new vscode.ThemeIcon('folder-opened'), detail: 'The space opens in that folder', folder: true },
    ...(repos.length ? [{ label: 'New git worktree of', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
    ...repos.map((s): Item => ({
      label: s.label,
      iconPath: new vscode.ThemeIcon('repo-forked'),
      description: 'a new branch from its main branch',
      detail: 'A separate checkout for one piece of work, so agents can work without touching this one',
      from: s,
    })),
  ];
  const where = await vscode.window.showQuickPick(items, { title, placeHolder: 'Where should the new space live?' });
  if (!where) return;
  if (!where.folder) return { from: where.from };
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

/** Rename a space, or a pane (shells: the pane label; agents: the agent's name). */
export async function rename(deps: ManageDeps, target: { space: Space; pane?: Pane }) {
  const { space, pane } = target;
  if (!pane) {
    const label = await vscode.window.showInputBox({ title: 'Rename space', value: space.label, validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
    if (!label?.trim()) return;
    await deps.actions.renameSpace(space.id, label.trim()).catch((e) => vscode.window.showErrorMessage(`Herdr: ${err(e)}`));
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
    if (pane.isAgent) await deps.actions.renameAgent(pane.id, name);
    else await deps.actions.renamePane(pane.id, name);
    // The VS Code tab carries the same name.
    const updated = await deps.findPane(pane.id);
    if (updated) await deps.renameTerminal(pane.id, tabName(updated.space.tabs.find((t) => t.id === pane.tabId), updated.pane));
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: ${err(e)}`);
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
      `Close the space "${space.label}" in Herdr?`,
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
      if (e?.code !== 'workspace_group_close_required') return void vscode.window.showErrorMessage(`Herdr: ${err(e)}`);
      const all = await vscode.window.showWarningMessage(
        `"${space.label}" has worktree spaces.`,
        { modal: true, detail: 'Herdr closes a space together with its worktree spaces. Their worktree folders stay on disk.' },
        'Close All',
      );
      if (all) await deps.actions.closeSpace(space.id, true).catch((e2) => vscode.window.showErrorMessage(`Herdr: ${err(e2)}`));
    }
    return;
  }
  const tab = space.tabs.find((t) => t.id === pane.tabId);
  const name = paneName(tab, pane);
  const ok = await vscode.window.showWarningMessage(
    `Close "${name}" in Herdr?`,
    { modal: true, detail: `${pane.isAgent ? 'The agent' : 'The shell and anything running in it'} will stop. Closing the VS Code tab instead only detaches.` },
    'Close',
  );
  if (!ok) return;
  const only = !tab || tab.panes.length <= 1;
  await (only && tab ? deps.actions.closeTab(tab.id) : deps.actions.closePane(pane.id)).catch((e) =>
    vscode.window.showErrorMessage(`Herdr: ${err(e)}`),
  );
}

/** Delete a worktree space and its folder; offers to force it when there are uncommitted changes. */
async function removeWorktree(deps: ManageDeps, space: Space) {
  try {
    await deps.actions.removeWorktree(space.id);
  } catch (e) {
    const force = await vscode.window.showWarningMessage(
      `Herdr didn't delete the worktree "${space.label}".`,
      { modal: true, detail: `${err(e)}\n\nDelete it anyway? Uncommitted changes in ${space.cwd} will be lost.` },
      'Delete Anyway',
    );
    if (force) await deps.actions.removeWorktree(space.id, true).catch((e2) => vscode.window.showErrorMessage(`Herdr: ${err(e2)}`));
  }
}
