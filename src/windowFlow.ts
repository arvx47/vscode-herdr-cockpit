// Which window a space opens in and switching this window to it: carries out decidePlacement() (placement.ts),
// mounts the space's folder (folders.ts) and opens its panes as tabs (terminals.ts). Moved out of extension.ts's
// activate().
import * as vscode from 'vscode';
import { EXTENSION_NAME, MESSAGE_PREFIX } from './brand';
import * as fs from 'fs';
import { errorText, HerdrClient } from './herdrClient';
import { attachOrder, findPane, Model, Pane, Space } from './model';
import { decidePlacement, followsInto, insideFolders, Placement, WindowMode } from './placement';
import { isMounted, mountSpace, PREFIX } from './folders';
import { LINK_VERSION, normPath, spacesWorkspaceFile, windowWithSpace, writePendingLink } from './hubFiles';
import { isWelcomeTab } from './tabRestore';
import type { AttachTerminals } from './terminals';

/** This window switched spaces itself: follow mode may act here (see isManagedWindow in extension.ts). */
export const MANAGED_KEY = 'herdr.managedWindow';
/** The user chose to switch spaces in this (non-hub) window rather than the Cockpit window. */
export const THIS_WINDOW_KEY = 'herdr.useThisWindow';
/** herdr.windowMode = folder: where this window opens a space it doesn't have, when you chose "always". */
export const PLACE_KEY = 'herdr.placeSpaces';

export interface SwitchOptions {
  /** Following a switch made in Herdr (follow mode): no placement question, polite attaches. */
  fromHerdr?: boolean;
  /** Mount next to the other spaces instead of swapping them out. */
  pin?: boolean;
  /** Open the space's panes as tabs (default: herdr.autoAttach). */
  autoAttach?: boolean;
  /** The pane this switch is for. */
  pane?: Pane;
  /** An explicit choice (right-click): its own window or this one. */
  place?: Placement;
}

export interface WindowFlowDeps {
  state: vscode.Memento;
  log(line: string): void;
  model(): Model | undefined;
  terms: AttachTerminals;
  client: HerdrClient;
  socketPath(): string;
  isHubWindow(): boolean;
  openHub(): Promise<void>;
  /** A space's folder was mounted here (terminal settings, redraw). */
  mounted(): void;
  /** This window asked Herdr to focus the space (follow mode mustn't bounce back). */
  focused(spaceId: string): void;
}

export class WindowFlow {
  /** The folder each space had while it was open in this window: removing that folder means the space left. */
  private spaceFolders = new Map<string, string>();
  /** Switches running in this window (they can overlap: a quick pick waits while follow mode starts another). */
  private running = 0;

  constructor(private deps: WindowFlowDeps) {}

  private cfg() {
    return vscode.workspace.getConfiguration('herdr');
  }

  /** A switch is under way: follow mode waits. */
  get switching(): boolean {
    return this.running > 0;
  }

  windowMode() {
    return this.cfg().get<WindowMode>('windowMode', 'folder');
  }

  myFolders() {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => normPath(f.uri.fsPath));
  }

  /** Remember each mounted space's folder (on every render); forget spaces that are gone from Herdr. */
  noteFolders(model: Model | undefined) {
    for (const sp of model?.spaces ?? []) {
      if (sp.cwd && isMounted(sp)) {
        this.spaceFolders.set(sp.id, normPath(sp.cwd));
      }
    }
    if (!model) {
      return;
    }
    // Spaces closed in Herdr don't come back with the same id.
    for (const id of [...this.spaceFolders.keys()]) {
      if (!model.spaces.some((s) => s.id === id)) {
        this.spaceFolders.delete(id);
      }
    }
  }

  /** This window is the space's own window: its only folder is the space's. */
  private isOwnWindow(space: Space) {
    const folders = this.myFolders();
    return !!space.cwd && folders.length === 1 && folders[0] === normPath(space.cwd);
  }

  /**
   * The space is open in this window: its folder is one of ours, or we have tabs of it and the folder it had here
   * is still ours (its shell may have moved). Once you remove that folder, the space isn't here anymore, even with
   * its tabs still open, so the next pane you open from it asks again.
   */
  isOpenHere(space: Space) {
    if (isMounted(space) || this.isInsideFolder(space)) {
      return true;
    }
    const folder = this.spaceFolders.get(space.id);
    return this.deps.terms.spaces().includes(space.id) && !!folder && this.myFolders().includes(folder);
  }

  /**
   * The space's folder is a subfolder of one of this window's: it belongs here from the first time the window
   * opens, without tabs or memory of it (a shell that `cd`'d into `repo/src` moves its space's folder there).
   * Not linked worktrees: they live in their own folder (~/.herdr/worktrees) and get a window of their own.
   */
  private isInsideFolder(space: Space): boolean {
    if (!space.cwd || space.worktree?.is_linked_worktree) {
      return false;
    }
    return insideFolders(normPath(space.cwd), this.myFolders());
  }

  private otherWindow(space: Space) {
    try {
      return windowWithSpace(space, { scheme: vscode.env.uriScheme, pid: process.pid, socket: this.deps.socketPath() });
    } catch {
      return undefined;
    }
  }

  /**
   * Hand a space (and a pane of it) over to another window through the pending link: the window that opens on
   * `folder`, or the Cockpit window when there's no folder. That window opens the space's tabs once it's up.
   */
  private handOver(space: Space, pane?: Pane, folder?: string) {
    const q = new URLSearchParams({ v: String(LINK_VERSION), space: space.id, label: space.label, ...(pane && { pane: pane.id }) });
    writePendingLink(vscode.env.uriScheme, '/open', q.toString(), undefined, folder);
  }

  private warnNoCwd(space: Space) {
    void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: no working directory known for space "${space.label}".`);
  }

  private async ensureMounted(space: Space, pin = false): Promise<boolean> {
    const r = await mountSpace(space, pin);
    if (r === 'no-window') {
      const pick = await vscode.window.showWarningMessage(
        `${MESSAGE_PREFIX}: open a folder or the ${EXTENSION_NAME} window first, so spaces can be mounted next to it.`,
        'Set up Cockpit window',
      );
      if (pick) {
        vscode.commands.executeCommand('herdr.setupHub');
      }
      return false;
    }
    if (r === 'no-cwd') {
      this.warnNoCwd(space);
      return false;
    }
    if (r === 'failed') {
      vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: VS Code refused to mount ${space.cwd}.`);
      return false;
    }
    await this.deps.state.update(MANAGED_KEY, true);
    this.deps.mounted();
    return true;
  }

  /**
   * Switching spaces outside the Cockpit window turns the window into an untitled workspace (or adds folders to
   * the user's own workspace). The first time, offer the Cockpit window instead; a window with no folder can't
   * take spaces, so it goes straight to the hub. True: go ahead here.
   */
  private async useThisWindow(space: Space, pane?: Pane): Promise<boolean> {
    if (this.deps.isHubWindow() || this.deps.state.get<boolean>(THIS_WINDOW_KEY)) {
      return true;
    }
    const toHub = async () => {
      this.handOver(space, pane);
      await this.deps.openHub();
      return false;
    };
    if (!vscode.workspace.workspaceFolders?.length) {
      return toHub();
    }
    const wsf = vscode.workspace.workspaceFile;
    let why = `Switching spaces here adds folders to your workspace "${vscode.workspace.name}".`;
    if (!wsf) {
      why = 'Switching spaces here makes this window an untitled workspace.';
    } else if (wsf.scheme === 'untitled') {
      why = 'This window is an untitled workspace.';
    }
    const pick = await vscode.window.showInformationMessage(
      `${why} Open the ${EXTENSION_NAME} window instead?`,
      { modal: true, detail: "The Cockpit window's first folder never changes, so switching spaces there never restarts your extensions. This window remembers your choice." },
      'Open Cockpit Window',
      'Use This Window',
    );
    if (pick === 'Open Cockpit Window') {
      return toHub();
    }
    if (pick !== 'Use This Window') {
      return false;
    }
    await this.deps.state.update(THIS_WINDOW_KEY, true);
    return true;
  }

  /**
   * herdr.autoAttach. Until it's set, the two settings it replaced (0.3.0) still decide: autoAttachOnSwitch
   * false = none, autoAttachShells false = agents.
   */
  private autoAttachMode(): 'all' | 'agents' | 'none' {
    const set = this.cfg().inspect<'all' | 'agents' | 'none'>('autoAttach');
    const chosen = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
    if (chosen) {
      return chosen;
    }
    if (this.cfg().get<boolean>('autoAttachOnSwitch') === false) {
      return 'none';
    }
    if (this.cfg().get<boolean>('autoAttachShells') === false) {
      return 'agents';
    }
    return 'all';
  }

  /**
   * Open the space in a window of its own: the one that already has it (brought forward), else a new window on
   * its folder (this one, when this window has no folder). The window that opens it attaches the pane through a
   * pending link aimed at that folder.
   */
  private async openInWindow(space: Space, pane?: Pane) {
    if (!space.cwd) {
      this.warnNoCwd(space);
      return;
    }
    const win = this.otherWindow(space);
    // The space lives in that window from now on: close its tabs here (only detaches; the panes keep running in
    // Herdr), so the same pane isn't open twice and this copy doesn't turn read-only when that window takes it.
    this.deps.terms.closeSpace(space.id);
    const cwd = normPath(space.cwd);
    // Aimed at a folder that window has: the space's, or (matched by label after its folder moved) its first.
    let target = cwd;
    if (win && !win.folders.includes(cwd)) {
      target = win.folders[0];
    }
    this.handOver(space, pane, target);
    if (win && !win.focus) {
      vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: "${space.label}" is open in another window (an untitled workspace). Switch to it from the Window menu.`);
      return;
    }
    const uri = vscode.Uri.file(win?.focus ?? cwd);
    const here = !win && !vscode.workspace.workspaceFolders?.length;
    // An editor brings forward the window that already has this folder or workspace instead of opening another.
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !here });
  }

  /**
   * Add a space to a window without a workspace file. Adding the folder in place would make it an untitled
   * workspace, which other windows can't bring forward, so this window reopens on a workspace file with its
   * folders plus the space's (~/.herdr-cockpit/workspaces) and opens the space's tabs once it's back, through a
   * pending link aimed at the space's folder. Reopening reloads the window; the panes keep running in Herdr.
   */
  private async reopenWithSpace(space: Space, pane?: Pane) {
    if (!space.cwd) {
      this.warnNoCwd(space);
      return;
    }
    const folders: { path: string; name?: string }[] = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ path: f.uri.fsPath, name: f.name }));
    folders.push({ path: space.cwd, name: PREFIX + space.label });
    // An untitled workspace's own settings come along; a single folder's stay in its .vscode/settings.json.
    let settings: Record<string, unknown> = {};
    const untitled = vscode.workspace.workspaceFile;
    if (untitled?.scheme === 'untitled') {
      try {
        settings = JSON.parse(fs.readFileSync(untitled.fsPath, 'utf8')).settings ?? {};
      } catch {
        // unreadable: start without settings
      }
    }
    let file: string;
    try {
      file = spacesWorkspaceFile(folders, settings);
    } catch (e) {
      vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: could not write a workspace file for this window: ${errorText(e)}`);
      return;
    }
    this.handOver(space, pane, space.cwd);
    this.deps.log(`reopening this window on ${file} to add ${space.label}`);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceNewWindow: false });
  }

  /** Ask where a space this window doesn't have goes; "Always…" is remembered for this window. */
  private async askPlacement(space: Space, pane?: Pane): Promise<Placement | undefined> {
    type Item = vscode.QuickPickItem & { place?: Placement; remember?: boolean };
    // Same words as the right-click menu: a pane is attached, a space is opened or added.
    let own: Item = { label: "$(window) Attach in its space's window", description: space.cwd, place: 'window' };
    let add: Item = { label: '$(terminal) Attach in this window', description: "adds the space's folder to this window", place: 'workspace' };
    if (!pane) {
      own = { label: '$(window) Open in its own window', description: space.cwd, place: 'window' };
      add = { label: '$(folder-library) Add to this window', description: 'next to the folders this window has', place: 'workspace' };
    }
    const items: Item[] = [
      own,
      add,
      { label: 'Remember for this window', kind: vscode.QuickPickItemKind.Separator },
      { label: "Always use the space's own window", place: 'window', remember: true },
      { label: 'Always add spaces to this window', place: 'workspace', remember: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `"${space.label}" isn't open in this window`,
      placeHolder: 'Right-click a space or pane to pick either one later',
    });
    if (pick?.remember) {
      await this.deps.state.update(PLACE_KEY, pick.place);
    }
    return pick?.place;
  }

  /**
   * Before switching to a space: 'here' = switch this window, 'add' = mount it next to this window's folders,
   * 'elsewhere' = another window has it or gets it (or you cancelled). `how` is an explicit choice (right-click).
   */
  private async placeSpace(space: Space, pane?: Pane, how?: Placement): Promise<'here' | 'add' | 'stay' | 'elsewhere'> {
    const decision = decidePlacement({
      how,
      pane: !!pane,
      mode: this.windowMode(),
      ownWindow: this.isOwnWindow(space),
      openHere: this.isOpenHere(space),
      mounted: isMounted(space),
      insideFolder: this.isInsideFolder(space),
      otherWindow: !!this.otherWindow(space),
      hasFolders: !!vscode.workspace.workspaceFolders?.length,
      remembered: this.deps.state.get<Placement>(PLACE_KEY),
    });
    let choice: Placement | undefined;
    switch (decision) {
      case 'here':
      case 'add':
      case 'stay':
        return decision;
      case 'askHub':
        if (await this.useThisWindow(space, pane)) {
          return 'here';
        }
        return 'elsewhere';
      case 'window':
        await this.openInWindow(space, pane);
        return 'elsewhere';
      case 'ask':
        choice = await this.askPlacement(space, pane);
        if (choice === 'workspace') {
          return 'add';
        }
        if (choice === 'window') {
          await this.openInWindow(space, pane);
        }
        return 'elsewhere';
    }
  }

  /**
   * The editor's Welcome / walkthrough page is in the way once a space is open: close it. The tab API shows
   * it as a tab without an input (like other built-in editors), so it's recognized by its label.
   */
  private closeWelcome() {
    const welcome = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isWelcomeTab);
    if (welcome.length) {
      vscode.window.tabGroups.close(welcome).then(undefined, () => undefined);
    }
  }

  /** False when the switch didn't happen in this window (handed to another window, cancelled, or the folder couldn't be mounted). */
  async switchTo(space: Space, opts: SwitchOptions = {}): Promise<boolean> {
    this.running++;
    try {
      return await this.switchNow(space, opts);
    } finally {
      this.running--;
    }
  }

  private async switchNow(space: Space, opts: SwitchOptions): Promise<boolean> {
    const { terms, log } = this.deps;
    /** The space is here without a folder of its own to mount (its folder is inside one of ours). */
    let stay = false;
    if (opts.fromHerdr) {
      // A space in a subfolder of ours is this window's too: followed into, and opened without mounting.
      const inside = this.isInsideFolder(space);
      if (!followsInto({ otherWindow: !!this.otherWindow(space), mode: this.windowMode(), hub: this.deps.isHubWindow(), mounted: isMounted(space) || inside })) {
        return false;
      }
      if (inside && !isMounted(space)) {
        stay = true;
        opts = { ...opts, pin: true };
      }
    } else {
      const where = await this.placeSpace(space, opts.pane, opts.place);
      if (where === 'elsewhere') {
        return false;
      }
      // The pick can take a while: go on with the space and pane as Herdr has them now.
      const model = this.deps.model();
      const now = model?.spaces.find((s) => s.id === space.id);
      if (!now) {
        vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: "${space.label}" isn't in Herdr anymore.`);
        return false;
      }
      space = now;
      if (opts.pane) {
        opts = { ...opts, pane: findPane(model, opts.pane.id)?.pane };
      }
      if (where === 'stay') {
        // A pane: attachPane opens it. The space: its tabs open here next to the others, mounting nothing.
        if (opts.pane) {
          return true;
        }
        stay = true;
        opts = { ...opts, pin: true };
      }
      if (where === 'add') {
        opts = { ...opts, pin: true };
        // A window opened from a workspace file on disk (the Cockpit window, a saved or generated one) takes the
        // folder in place; any other reopens on a workspace file.
        if (!isMounted(space) && vscode.workspace.workspaceFile?.scheme !== 'file') {
          await this.reopenWithSpace(space, opts.pane);
          return false;
        }
      }
    }
    if (!stay && !(await this.ensureMounted(space, !!opts.pin))) {
      return false;
    }
    this.closeWelcome();
    if (space.cwd && this.cfg().get<boolean>('revealInExplorer', false)) {
      vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(space.cwd)).then(undefined, () => {});
    }
    if (!opts.fromHerdr) {
      await this.deps.client.request('workspace.focus', { workspace_id: space.id }).catch((e) => log(`workspace.focus: ${errorText(e)}`));
      this.deps.focused(space.id);
    }
    if (!opts.pin && this.cfg().get<boolean>('closeTerminalsOnSwitch', true)) {
      terms.closeOtherSpaces(space.id);
    }
    const mode = this.autoAttachMode();
    if (opts.autoAttach ?? mode !== 'none') {
      // Every pane gets its own tab: agents (most urgent first), then shells in Herdr's tab order.
      // Tabs appear in the order they're opened (editor and panel alike): open all, then focus the first.
      const panes = attachOrder(space, mode === 'all');
      // Following Herdr, a pane another editor's Cockpit window has stays with it (shown read-only here).
      const polite = !!opts.fromHerdr;
      for (const p of panes) {
        terms.attach(p, { preserveFocus: true, polite });
      }
      if (panes[0]) {
        terms.attach(panes[0], { polite });
      }
    }
    return true;
  }

  /** Open a pane's tab, switching to (or placing) its space first when this window doesn't have it. */
  async attachPane(space: Space, pane: Pane, startingAs?: string) {
    if (!this.deps.terms.has(pane.id) && space.cwd && !(await this.switchTo(space, { autoAttach: false, pane }))) {
      return;
    }
    this.showPane(pane, startingAs);
  }

  /** Open (or focus) the pane's tab in this window, its space already placed here. */
  showPane(pane: Pane, startingAs?: string) {
    this.deps.terms.attach(pane, { startingAs });
    if (pane.isAgent) {
      this.deps.client.request('agent.focus', { target: pane.id }).catch(() => {});
    }
  }
}
