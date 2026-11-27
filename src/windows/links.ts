// Deep links (from the Herdr plugin, or any web page: parseLink in hubFiles.ts validates them) and the hand-off
// between windows of one editor through ~/.herdr-cockpit/pending-link.json. Moved out of extension.ts's
// activate(); what a link does with a space or pane goes back through LinkDeps.
import * as vscode from 'vscode';
import { EXTENSION_NAME, MESSAGE_PREFIX } from '../util/brand';
import * as fs from 'fs';
import * as os from 'os';
import { sessionSocketPath } from '../drivers/herdr/herdrClient';
import { allPanes, findPane, Model, Pane, Space } from '../state/model';
import { sessionOfSocket } from '../drivers/herdr/connection';
import { ensureHubWorkspace, hubDir, hubOpen, isInsideRoots, LinkRequest, parseLink, takePendingLink, writePendingLink } from './hubFiles';
import { fileLinkRoots } from './linkRoots';
import { SHELL_PROFILE_TITLE } from '../terminal/profiles';
import { errorText } from '../util/errors';

/** The button that opens the Cockpit window for a link. */
const OPEN_COCKPIT = `Open ${EXTENSION_NAME}`;

/** Only task terminals get a description; others show just their name. */
export const HUB_TAB_DESCRIPTION = '${task}';
/** terminal.integrated.defaultProfile.<key> for this OS. */
export const PLATFORM_KEY = platformKey();
function platformKey(): string {
  if (process.platform === 'darwin') {
    return 'osx';
  }
  if (process.platform === 'win32') {
    return 'windows';
  }
  return 'linux';
}

export interface LinkDeps {
  log(line: string): void;
  isHubWindow(): boolean;
  /** This window's folders (normalized). */
  myFolders(): string[];
  socketPath(): string;
  model(): Model | undefined;
  isConnected(): boolean;
  kick(): Promise<void>;
  ensureConnected(): Promise<boolean>;
  review(space: Space, pane?: Pane): Promise<unknown>;
  /** Switch this window to the space unless it already shows it. */
  showSpace(space: Space): Promise<void>;
  attachPane(space: Space, pane: Pane): Promise<void>;
  /** The space is open in this window. */
  isOpenHere(space: Space): boolean;
  /** Hand the link to another window that has the space open and bring it forward; false when none has it. */
  sendToWindow(space: Space, linkPath: string, query: string): Promise<boolean>;
}

/** The space (and pane) a link names, as Herdr has them now: the pane's space, else by id, else by label. */
function linkTarget(req: { space?: string; pane?: string; label?: string }, model: Model | undefined) {
  let hit: { space: Space; pane: Pane } | undefined;
  if (req.pane) {
    hit = findPane(model, req.pane);
  }
  let space = hit?.space ?? model?.spaces.find((s) => s.id === req.space);
  if (!space && req.label) {
    space = model?.spaces.find((s) => s.label === req.label);
  }
  return { space, pane: hit?.pane };
}

export class Links implements vscode.Disposable {
  private scheme = vscode.env.uriScheme;
  private watcher?: fs.FSWatcher;

  constructor(private deps: LinkDeps) {}

  /** The Herdr session this window talks to; undefined = the default session. */
  currentSession() {
    return sessionOfSocket(this.deps.socketPath());
  }

  /** Create the hub workspace if needed and open it (an editor focuses it if it's already open). */
  async openHub(newWindow = true) {
    const file = ensureHubWorkspace({
      'files.exclude': { 'herdr-cockpit.code-workspace': true },
      // Cockpit window = editor + Herdr; hide the built-in AI chat here only.
      'chat.disableAIFeatures': true,
      'workbench.secondarySideBar.defaultVisibility': 'visible',
      'terminal.integrated.tabs.description': HUB_TAB_DESCRIPTION,
      [`terminal.integrated.defaultProfile.${PLATFORM_KEY}`]: SHELL_PROFILE_TITLE,
      // The hub opens on your spaces, not the editor's Welcome page.
      'workbench.startupEditor': 'none',
    });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceNewWindow: newWindow });
  }

  /**
   * A link from the Herdr plugin (or anywhere: links are validated in parseLink and can only pick a space,
   * pane or file). A link for a space acts in the window that has the space open (this one, or another window
   * it's handed to); anything else acts in the Cockpit window, so another window hands it over and opens the hub.
   */
  async handle(uri: vscode.Uri) {
    let req: LinkRequest;
    try {
      req = parseLink(uri.path, uri.query);
    } catch (e) {
      vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: can't open this link: ${errorText(e)}.`);
      return;
    }
    if (!this.deps.isHubWindow()) {
      const where = await this.windowFor(req, uri);
      if (where === 'here') {
        await this.run(req);
        return;
      }
      if (where === 'sent') {
        return;
      }
      // Any web page can open a link: without a Cockpit window open, ask before creating and opening one.
      if (!hubOpen(this.scheme)) {
        const pick = await vscode.window.showInformationMessage(
          `A link asks ${EXTENSION_NAME} to show a space or pane. Open the ${EXTENSION_NAME} window for it?`,
          { modal: true },
          OPEN_COCKPIT,
        );
        if (pick !== OPEN_COCKPIT) {
          return;
        }
      }
      writePendingLink(this.scheme, uri.path, uri.query);
      await this.openHub();
      return;
    }
    await this.run(req);
  }

  /**
   * Where a link that reached a window other than the Cockpit window acts: 'here' when this window has its space
   * open, 'sent' when it was handed to another window that has it, 'hub' otherwise (no space, another Herdr
   * session, not connected, or no window has the space).
   */
  private async windowFor(req: LinkRequest, uri: vscode.Uri): Promise<'here' | 'sent' | 'hub'> {
    if (req.kind === 'file' || (req.session !== undefined && req.session !== this.currentSession()) || !this.deps.isConnected()) {
      return 'hub';
    }
    const { space } = linkTarget(req, this.deps.model());
    if (!space) {
      return 'hub';
    }
    if (this.deps.isOpenHere(space)) {
      return 'here';
    }
    if (await this.deps.sendToWindow(space, uri.path, uri.query)) {
      return 'sent';
    }
    return 'hub';
  }

  private async run(req: LinkRequest) {
    const d = this.deps;
    d.log(`link: ${req.kind} ${JSON.stringify(req)}`);
    const current = this.currentSession();
    if (req.session !== undefined && req.session !== current) {
      let connected = 'the default session';
      if (current) {
        connected = `"${current}"`;
      }
      // Modal: switching changes herdr.socketPath for every window.
      const pick = await vscode.window.showWarningMessage(
        `This link is for the Herdr session "${req.session}", but ${EXTENSION_NAME} is connected to ${connected}.`,
        { modal: true, detail: 'Switching changes the herdr.socketPath setting, so every window connects to that session.' },
        `Switch to "${req.session}"`,
      );
      if (!pick) {
        return;
      }
      await vscode.workspace.getConfiguration('herdr').update('socketPath', sessionSocketPath(req.session), vscode.ConfigurationTarget.Global);
      await d.kick();
    }
    const model = d.model();
    if (req.kind === 'file') {
      // Files in your spaces, panes or open folders open directly; anything else asks.
      const roots = fileLinkRoots(
        [
          ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
          ...(model?.spaces ?? []).map((s) => s.cwd),
          ...allPanes(model).map(({ pane }) => pane.cwd),
        ],
        os.homedir(),
      );
      if (!isInsideRoots(req.path, roots)) {
        const ok = await vscode.window.showWarningMessage(
          `A link asks to open ${req.path}, which isn't in a Herdr space or an open folder.`,
          { modal: true },
          'Open',
        );
        if (ok !== 'Open') {
          return;
        }
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.path)).then(undefined, () => undefined);
      if (!doc) {
        vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: can't open ${req.path}.`);
        return;
      }
      const pos = new vscode.Position(Math.max(0, (req.line ?? 1) - 1), Math.max(0, (req.col ?? 1) - 1));
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
      return;
    }
    if (!d.isConnected()) {
      await d.kick();
    }
    if (!d.isConnected() && !(await d.ensureConnected())) {
      return;
    }
    const { space: sp, pane } = linkTarget(req, d.model());
    vscode.commands.executeCommand('herdr.spaces.focus').then(undefined, () => {});
    if (!sp) {
      if (req.space || req.label || req.pane) {
        vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: that space or pane isn't running anymore. It may have closed in Herdr.`);
      }
      return;
    }
    if (req.kind === 'review') {
      await d.review(sp, pane);
      return;
    }
    await d.showSpace(sp);
    if (pane) {
      await d.attachPane(sp, pane);
    }
  }

  /** A link handed over by another window of this editor: to the Cockpit window, or to the window with its folder. */
  takeHandoff() {
    const p = takePendingLink(this.scheme, undefined, undefined, (folder) => {
      if (folder) {
        return this.deps.myFolders().includes(folder);
      }
      return this.deps.isHubWindow();
    });
    if (!p) {
      return;
    }
    let req: LinkRequest;
    try {
      req = parseLink(p.path, p.query);
    } catch {
      // validated before it was written; a stale or edited file is ignored
      return;
    }
    this.run(req).catch((e) => this.deps.log(`link failed: ${errorText(e)}`));
  }

  /** Take hand-offs as they're written (only windows that can take one: the Cockpit window or one with folders). */
  watchHandoffs() {
    if (!this.deps.isHubWindow() && !vscode.workspace.workspaceFolders?.length) {
      return;
    }
    try {
      fs.mkdirSync(hubDir(), { recursive: true }); // a pre-rename Cockpit window may not have it yet
      this.watcher = fs.watch(hubDir(), (_e, name) => {
        if (name === 'pending-link.json') {
          setTimeout(() => this.takeHandoff(), 100);
        }
      });
      // Without a listener, a watcher error (the folder deleted, too many open files) throws in the extension host.
      this.watcher.on('error', (e) => {
        this.deps.log(`watching ${hubDir()} stopped: ${errorText(e)}`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // no hub folder yet
    }
  }

  dispose() {
    this.watcher?.close();
  }
}
