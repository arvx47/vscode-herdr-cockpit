// Creating, renaming and closing Herdr spaces and tabs from VS Code: the quick picks, input boxes
// and confirmations around src/herdrActions.ts. Every new pane opens straight away in a terminal tab.
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { AGENT_KINDS, AGENT_NAME, agentName, agentTitle, HerdrActions } from './herdrActions';
import type { Pane, Space } from './model';
import { paneName, tabName } from './viewState';

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
  /** Agent names in use (agent names must be unique). */
  agentNames(): string[];
  /** Agents listed first when choosing (setting herdr.agents). */
  agents(): string[];
  renameTerminal(paneId: string, name: string): Promise<void>;
  /** Herdr is connected, offering to start it if not. */
  ensureConnected(): Promise<boolean>;
  log(msg: string): void;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "Shell", "Shell with a name…", then agents with their logos. Undefined if cancelled. */
export async function pickWhat(deps: ManageDeps, title: string): Promise<What | undefined> {
  type Item = vscode.QuickPickItem & { what?: What; more?: boolean; named?: boolean };
  const favorites = deps.agents().filter((k) => k in AGENT_KINDS);
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
    const kind = await pickAgent(deps, title, favorites);
    return kind ? { kind } : undefined;
  }
  return pick.what;
}

/** Any agent Herdr can start, except `skip`. Undefined if cancelled. */
export async function pickAgent(deps: ManageDeps, title: string, skip: string[] = []): Promise<string | undefined> {
  const items = Object.keys(AGENT_KINDS)
    .filter((k) => !skip.includes(k))
    .map((agent) => ({ label: agentTitle(agent), description: agent, iconPath: deps.agentIcon(agent) ?? new vscode.ThemeIcon('hubot'), agent }));
  return (await vscode.window.showQuickPick(items, { title, placeHolder: 'Agent to start' }))?.agent;
}

/**
 * Start an agent in a fresh pane, in the background: the tab is already open, so you watch it
 * launch. Herdr waits until the agent is ready for input.
 */
export function startAgent(deps: ManageDeps, paneId: string, kind: string, where: string) {
  const name = agentTitle(kind);
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Starting ${name} in ${where}…` },
    async () => {
      try {
        await deps.actions.startAgent(paneId, kind, agentName(kind, deps.agentNames()));
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

/** New space: in a folder you pick, or on a new git worktree of an existing space's repo. */
export async function newSpace(deps: ManageDeps) {
  if (!(await deps.ensureConnected())) return;
  const title = 'New space';
  type Item = vscode.QuickPickItem & { folder?: boolean; from?: Space };
  const repos = deps.spaces().filter((s) => s.cwd && deps.branchOf(s.cwd));
  const items: Item[] = [
    { label: 'Choose a folder…', iconPath: new vscode.ThemeIcon('folder-opened'), detail: 'The space opens in that folder', folder: true },
    ...(repos.length ? [{ label: 'New git worktree of', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
    ...repos.map((s): Item => ({
      label: s.label,
      iconPath: new vscode.ThemeIcon('repo-forked'),
      description: `branch off ${deps.branchOf(s.cwd)}`,
      detail: 'A separate checkout on a new branch, so agents can work without touching this one',
      from: s,
    })),
  ];
  const where = await vscode.window.showQuickPick(items, { title, placeHolder: 'Where should the new space live?' });
  if (!where) return;

  let create: () => Promise<{ pane: { pane_id: string } }>;
  let label: string;
  if (where.folder) {
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
    const name = await vscode.window.showInputBox({ title, prompt: 'Space name', value: path.basename(dir.fsPath), validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
    if (!name?.trim()) return;
    label = name.trim();
    create = () => deps.actions.createSpace({ cwd: dir.fsPath, label });
  } else {
    const from = where.from!;
    const branch = await vscode.window.showInputBox({
      title: `New worktree of ${from.label}`,
      prompt: `New branch name (created from ${deps.branchOf(from.cwd)})`,
      placeHolder: 'e.g. feat/new-idea',
      validateInput: (v) => (!v.trim() ? 'Enter a branch name' : /\s|\.\.|[~^:?*[\\]|^[-/]|[/.]$|@\{/.test(v.trim()) ? 'Not a valid git branch name' : undefined),
    });
    if (!branch?.trim()) return;
    label = branch.trim();
    create = () => deps.actions.createWorktreeSpace({ workspace_id: from.id, cwd: from.cwd, branch: label, label });
  }

  const what = await pickWhat(deps, `Start in "${label}"`);
  if (!what) return;
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
