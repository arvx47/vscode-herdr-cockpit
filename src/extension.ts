import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorText, HerdrClient, resolveSocketPath, sessionSocketPath } from './herdrClient';
import { allPanes, AgentStatus, attachOrder, countByStatus, findPane, Model, needingAttention, Pane, Space } from './model';
import type { PaneProcessInfoResult } from './herdrTypes';
import { HerdrPanel, PanelAction } from './panel';
import { HerdrSync } from './herdrSync';
import { decidePlacement, followsInto, Placement, WindowMode } from './placement';
import { ActivityTarget, ActivityWatcher, describeProcess, isShellProcess, leaderProcess } from './activity';
import { AGENT_TAB_PREFIX, AgentNames, buildViewState, paneName, setAgentNames, tabName, ViewConnection } from './viewState';
import { agentLogo } from './agentLogos';
import { gitInfo } from './gitInfo';
import { isMounted, mountSpace, PREFIX, unmountSpace } from './folders';
import { AttachTerminals, TerminalLocationSetting } from './terminals';
import { TabAction } from './builtinTerminal';
import { findFileRefs } from './termLinks';
import { binaryFound, diagnose, DownReason, herdrEnv, resolveBinary, serverStatus, sessionOfSocket, startServer } from './connection';
import { claimant, claimNotification, editorCli, ensureHubWorkspace, hubDir, hubOpen, hubWorkspaceFile, HubStatus, isInsideRoots, legacyHubWorkspaceFile, OfferHubSetting, pruneClaims, readClaim, removeClaim, windowKey, writeClaim, shouldOfferHub, LINK_VERSION, LinkRequest, normPath, parseLink, removeHubStatus, removeWindowRecord, spacesWorkspaceFile, takePendingLink, WindowRecord, windowWithSpace, writeEditorRecord, writeHubStatus, writePendingLink, writeWindowRecord } from './hubFiles';
import { HERDR_PROTOCOL } from './herdrTypes';
import { reviewChanges } from './review';
import { showHelp } from './help';
import { agentSlug, HerdrActions } from './herdrActions';
import { ClosedTab, closedTab, closeInHerdr, ManageDeps, newSpace, newTab, rename, reopenTab } from './manage';
import { registerProfiles, SHELL_PROFILE_TITLE } from './profiles';
import { codexBinary, codexLiveUsage, ProviderUsage, readUsage } from './usage';
import { setUpClaudeUsage } from './usageSetup';

const MANAGED_KEY = 'herdr.managedWindow';
const REVEALED_KEY = 'herdr.hubViewRevealed';
/** The user chose to switch spaces in this (non-hub) window rather than the Cockpit window. */
const THIS_WINDOW_KEY = 'herdr.useThisWindow';
/** herdr.windowMode = folder: where this window opens a space it doesn't have, when you chose "always". */
const PLACE_KEY = 'herdr.placeSpaces';
/** The panes this window had tabs for, to reopen them when the window opens again (herdr.restoreTabs). */
const OPEN_TABS_KEY = 'herdr.openTabs';
/** How long after reopening them to look for tabs VS Code failed to draw. */
const UNDRAWN_CHECK_MS = 3000;
/** How many times to look (and replace) before giving up. */
const UNDRAWN_ATTEMPTS = 3;
/** Each window waits this much more than a likelier one before claiming an agent notification (notify()). */
const NOTIFY_STEP_MS = 300;


/** One line per reason Herdr is unreachable (status bar, menus). */
const DOWN_TEXT: Record<DownReason, string> = {
  'not-installed': "Herdr isn't installed.",
  'not-running': "Herdr isn't running.",
  crashed: 'Herdr stopped unexpectedly.',
  incompatible: "This Herdr version isn't compatible with Herdr Cockpit.",
  unreachable: "Herdr is running but isn't answering.",
};
/** terminal.integrated.defaultProfile.<key> for this OS. */
const PLATFORM_KEY = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
/** `herdr plugin install` source of the companion plugin (plugin/ in this repository). */
const PLUGIN_SOURCE = 'sriharirao92/vscode-herdr-cockpit/plugin';
/** Quote for a POSIX shell. */
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** Only task terminals get a description; others show just their name. */
const HUB_TAB_DESCRIPTION = '${task}';

/** The editor's Welcome / walkthrough page: a tab without an input, known only by its label (English UI). */
const isWelcomeTab = (t: vscode.Tab) => t.input === undefined && /^(Welcome|Get(ting)? Started)\b/.test(t.label);

/** What a command acts on: from the webview, its context menu, or nothing (then ask). */
type Target = { spaceId?: string; paneId?: string };

/** Webview action -> command id. */
const PANEL_COMMANDS: Record<string, string> = {
  switch: 'herdr.switchSpace',
  attach: 'herdr.attach',
  review: 'herdr.reviewChanges',
  attention: 'herdr.focusAttention',
  toggleShellPanes: 'herdr.toggleShellPanes',
  openSettings: 'herdr.openSettings',
  openHelp: 'herdr.openHelp',
  setupClaudeUsage: 'herdr.setupClaudeUsage',
  setKiroCredits: 'herdr.setKiroCredits',
  newTab: 'herdr.newTab',
  newSpace: 'herdr.newSpace',
  openTui: 'herdr.openTui',
  refresh: 'herdr.refresh',
  setupHub: 'herdr.setupHub',
  startServer: 'herdr.startServer',
  copyDiagnostics: 'herdr.copyDiagnostics',
  openInstallDocs: 'herdr.openInstallDocs',
};

export function activate(ctx: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration('herdr');
  const log = vscode.window.createOutputChannel('Herdr Cockpit');
  // The integration test (src/test/vscode) reads the log from the console.
  if (process.env.HERDR_HUB_TEST_SESSION) {
    const append = log.appendLine.bind(log);
    log.appendLine = (line: string) => (console.log(`[herdr-cockpit log] ${line}`), append(line));
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A .catch() handler that logs instead of leaving an unhandled rejection. */
  const logError = (what: string) => (e: unknown) => log.appendLine(`${what}: ${errorText(e)}`);
  const client = new HerdrClient(() => resolveSocketPath(cfg().get<string>('socketPath')));
  // When did each agent enter its current state? (observed locally; Herdr exposes only a sequence number)
  const stateSince = new Map<string, { status?: AgentStatus; at: number }>();
  const showShells = () => cfg().get<boolean>('showShellPanes', true);
  /** The sidebar lists only the spaces open in this window. */
  const panel = new HerdrPanel(ctx.extensionUri, (a: PanelAction) => {
    const id = PANEL_COMMANDS[a.command];
    if (id) vscode.commands.executeCommand(id, { spaceId: a.spaceId, paneId: a.paneId } satisfies Target);
  });
  const activity = new ActivityWatcher(client);
  const logoUri = (f: string) => vscode.Uri.joinPath(ctx.extensionUri, 'media', 'agent-logos', `${f}.svg`);
  /** The agent's logo as a tab / quick pick icon, or undefined when there's none. */
  const agentIcon = (kind?: string) => {
    const logo = agentLogo(kind);
    return !logo ? undefined : logo.mono ? { light: logoUri(`${logo.file}-light`), dark: logoUri(`${logo.file}-dark`) } : logoUri(logo.file);
  };
  /** This window across reloads, for pane claims. Windows without a workspace have no storage, so no key. */
  let thisWindow: string | undefined;
  if (ctx.storageUri) {
    thisWindow = windowKey(`${vscode.env.uriScheme}\n${ctx.storageUri.toString()}`);
  }
  const terms = new AttachTerminals(
    () => cfg().get<TerminalLocationSetting>('terminalLocation', 'editor'),
    (pane, startingAs) => {
      const tab = model?.spaces.flatMap((s) => s.tabs).find((t) => t.id === pane.tabId);
      const kind = pane.isAgent ? pane.agentKind : startingAs;
      return {
        name: tabName(tab, pane),
        iconPath: agentIcon(kind) ?? new vscode.ThemeIcon(pane.isAgent ? 'hubot' : 'terminal'),
      };
    },
    () => {
      scheduleRender();
      saveOpenTabs();
    },
    {
      binary: () => binary(),
      env: () => herdrEnvNow(),
      log: (line) => log.appendLine(line),
      // Herdr doesn't say who took a pane over: windows record the panes they take (hubFiles.ts, claims).
      claim: (paneId) => writeClaim(socketPath(), paneId, { editor: vscode.env.appName, scheme: vscode.env.uriScheme, pid: process.pid, at: Date.now(), window: thisWindow }),
      unclaim: (paneId) => removeClaim(socketPath(), paneId, process.pid),
      holder: (paneId, since) => claimant(readClaim(socketPath(), paneId), { scheme: vscode.env.uriScheme, pid: process.pid, window: thisWindow }, since),
      onTakenOver: (paneId, who, expected) => !expected && tookOver(paneId, who),
      request: (method, params, timeoutMs) => client.request(method, params, timeoutMs),
    },
    (paneId) => void closedTabByUser(paneId).catch(logError('close in Herdr')),
    (paneId, name) => void renamedTabByUser(paneId, name).catch(logError('rename in Herdr')),
  );
  /** Restored (or nothing to restore): until then, the saved list is the one from the last session. */
  let tabsRestored = false;
  /** Remember this window's tabs. Not while it closes: those tabs go with the window and should come back. */
  function saveOpenTabs() {
    if (!tabsRestored || terms.shuttingDown) {
      return;
    }
    void ctx.workspaceState.update(OPEN_TABS_KEY, terms.panes());
  }
  /**
   * Reopen the tabs this window had when it was closed, once Herdr answers. Panes that are gone (closed, or
   * Herdr restarted with new ids) are skipped. A pane another window has stays there, shown read-only here.
   */
  function restoreOpenTabs() {
    if (tabsRestored) {
      return;
    }
    tabsRestored = true;
    if (!cfg().get<boolean>('restoreTabs', true)) {
      return;
    }
    const saved = ctx.workspaceState.get<{ paneId: string; spaceId: string }[]>(OPEN_TABS_KEY, []);
    const panes = new Map(allPanes(model).map(({ pane }) => [pane.id, pane] as const));
    const reopened: Pane[] = [];
    for (const { paneId } of saved) {
      const pane = panes.get(paneId);
      if (pane && !terms.has(paneId)) {
        terms.attach(pane, { preserveFocus: true, polite: true });
        reopened.push(pane);
      }
    }
    if (saved.length) {
      log.appendLine(`reopened ${reopened.length} of ${saved.length} tabs from the last session`);
    }
    saveOpenTabs();
    if (reopened.length) {
      setTimeout(() => redrawUndrawn(reopened, 1), UNDRAWN_CHECK_MS);
    }
  }
  /**
   * Tabs created while the window is still starting can come out broken, empty and named after their internal id
   * ("e7ab…bf1"), in two ways:
   * - VS Code can't show terminals in the editor area yet, so it opens the tab as a text file of the terminal's
   *   `vscode-terminal:` address ("Unable to resolve resource vscode-terminal:/…" in its log). The terminal works,
   *   but no tab shows it, and the API can't tell which terminal a broken tab was for: replace them all.
   * - VS Code fails to draw the terminal ("A container element needs to be set with `attachToElement`…") and
   *   never opens it.
   * Look again after replacing, a few times, in case the window still wasn't ready.
   */
  function redrawUndrawn(panes: Pane[], attempt: number) {
    const textTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'vscode-terminal');
    let broken: Pane[];
    if (textTabs.length) {
      broken = panes.filter((p) => terms.has(p.id) || terms.undrawn(p.id));
    } else {
      broken = panes.filter((p) => terms.undrawn(p.id));
    }
    if (!broken.length && !textTabs.length) {
      return;
    }
    log.appendLine(`replacing ${broken.length} tab(s) VS Code didn't draw (${textTabs.length} opened as text), attempt ${attempt}`);
    void vscode.window.tabGroups.close(textTabs, true).then(
      () => {
        for (const p of broken) {
          terms.replace(p, { preserveFocus: true, polite: true });
        }
        if (attempt < UNDRAWN_ATTEMPTS) {
          setTimeout(() => redrawUndrawn(broken, attempt + 1), UNDRAWN_CHECK_MS);
        }
      },
      logError('closing broken tabs'),
    );
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'herdr.focusAttention';
  status.show();

  let model: Model | undefined;
  /** The folder each space had while it was open in this window: removing that folder means the space left. */
  const spaceFolders = new Map<string, string>();
  /** Each pane's name at the last snapshot, to notice renames made in Herdr. */
  const paneNames = new Map<string, string>();
  setAgentNames(cfg().get<AgentNames>('agentNames', 'title'));
  /** Set further down: write the Cockpit window's status file for the Herdr plugin (debounced). */
  let scheduleHubStatus = () => {};
  let lastStatus = new Map<string, AgentStatus | undefined>();
  let lastFocusedSpace: string | undefined;
  let firstLoad = true;
  let switching = false;

  // The Cockpit window is our own ~/.herdr-cockpit workspace file (or, from before the rename, ~/.herdr-hub's), and
  // nothing else: no setting a repository could ship makes a window the Cockpit window.
  const hubFiles = [hubWorkspaceFile(), legacyHubWorkspaceFile()];
  const isHubWindow = () => hubFiles.includes(vscode.workspace.workspaceFile?.fsPath ?? '');
  const isManagedWindow = () => isHubWindow() || ctx.workspaceState.get<boolean>(MANAGED_KEY, false);
  // git reads each repo's own config; only run it once the window is trusted (see gitInfo.ts).
  const git = (cwd?: string) => (vscode.workspace.isTrusted ? gitInfo(cwd, scheduleRender) : undefined);

  // ---------- connection (herdrSync.ts) ----------
  const socketPath = () => resolveSocketPath(cfg().get<string>('socketPath'));
  const binary = () => resolveBinary(cfg().get<string>('binaryPath'));
  const herdrEnvNow = () => herdrEnv(cfg().get<string>('socketPath') || undefined);
  /** The space whose tabs were open when Herdr went away, to offer reopening them. */
  let lostSpace: { id: string; label: string } | undefined;
  let lostNotified = false;
  const sync = new HerdrSync({
    client,
    socketPath,
    diagnose: (e) => diagnose(binary(), socketPath(), !!cfg().get<string>('socketPath'), herdrEnvNow(), e),
    onSnapshot: (next) => apply(next),
    onConnected() {
      lostNotified = false;
      restoreOpenTabs();
      const lost = lostSpace;
      lostSpace = undefined;
      if (lost) {
        void offerReopen(lost).catch(logError('reopen after outage'));
      }
    },
    onLost() {
      const sp = model?.spaces.find((s) => s.id === terms.spaces()[0]);
      lostSpace = sp ? { id: sp.id, label: sp.label } : undefined;
    },
    onDown(afterLoss) {
      model = undefined;
      if (afterLoss && !lostNotified) {
        void notifyLost().catch(logError('lost Herdr'));
      }
    },
    onChange() {
      render();
      renderStatus();
    },
    log: (line) => log.appendLine(line),
  });
  const isConnected = () => sync.connected;
  const refresh = () => sync.refresh();
  const kick = () => sync.kick();

  /** Herdr was connected and went away: say so once, since the agents stopped with it. */
  async function notifyLost() {
    const conn = sync.conn;
    if (conn.kind !== 'down') return;
    lostNotified = true;
    const msg =
      conn.reason === 'crashed'
        ? 'Herdr stopped unexpectedly. Your agents run inside Herdr, so they stopped too.'
        : conn.reason === 'not-running'
          ? 'Herdr stopped. Your agents run inside Herdr, so they stopped too.'
          : `Lost the connection to Herdr${conn.detail ? `: ${conn.detail}` : ''}.`;
    const pick = await vscode.window.showWarningMessage(msg, ...(conn.reason === 'not-running' || conn.reason === 'crashed' ? ['Start Herdr', 'Open Herdr TUI'] : ['Retry']));
    if (pick === 'Start Herdr') {
      await startHerdr();
    } else if (pick === 'Open Herdr TUI') {
      await vscode.commands.executeCommand('herdr.openTui');
    } else if (pick === 'Retry') {
      await kick();
    }
  }

  /**
   * You closed a Herdr tab yourself: close the pane in Herdr too (herdr.closeTabInHerdr). Asks first for an
   * agent, a shell running something, or the last tab of a space (Herdr then closes the whole space).
   */
  async function closedTabByUser(paneId: string) {
    const mode = cfg().get<'ask' | 'always' | 'never'>('closeTabInHerdr', 'ask');
    const hit = paneOf({ paneId });
    if (!hit) {
      return;
    }
    const closed = closedTab(hit.space, hit.pane);
    rememberClosed(closed);
    if (mode === 'never' || !isConnected()) {
      return;
    }
    const { space, pane } = hit;
    const name = paneName(space.tabs.find((t) => t.id === pane.tabId), pane);
    let running: string | undefined;
    if (!pane.isAgent) {
      const info = await client.request<PaneProcessInfoResult>('pane.process_info', { pane_id: paneId }).then((r) => r.process_info).catch(() => undefined);
      const lead = leaderProcess(info);
      if (lead && !isShellProcess(lead.name)) running = describeProcess(lead);
    }
    const last = space.tabs.flatMap((t) => t.panes).length === 1;
    if (last || (mode === 'ask' && (pane.isAgent || running))) {
      const detail = [
        pane.isAgent ? `${name} is an agent: closing it in Herdr stops it.` : running ? `It's running ${running}.` : undefined,
        last ? `It's the last tab of "${space.label}", so Herdr closes the space too.` : undefined,
        'Keep Running leaves it in Herdr; click it in the sidebar to open it again.',
      ]
        .filter(Boolean)
        .join(' ');
      const pick = await vscode.window.showWarningMessage(`Close ${name} in Herdr too?`, { modal: true, detail }, 'Close in Herdr', 'Keep Running');
      if (pick !== 'Close in Herdr') return;
    }
    await manage.actions.closePane(paneId);
    closed.closedInHerdr = true;
    log.appendLine(`closed ${paneId} in Herdr (tab closed)`);
    kick();
  }

  /**
   * What ⇧⌘T should reopen, newest last: a Herdr tab, or "editor" for any other editor tab, which only
   * VS Code's Reopen Closed Editor can bring back. VS Code can't rebuild our tabs (their stream belongs to
   * this extension), so herdr.reopenClosedTab replaces that command and hands "editor" entries to it.
   */
  /**
   * A closed editor tab that Reopen Closed Editor would bring back. Not: terminal tabs (ours or not, they're not
   * in VS Code's history), the text tabs VS Code opens for terminals it couldn't draw and the Welcome page (this
   * extension closes both itself), or a tab that only moved to another group (closed there, opened here).
   */
  function reopenableEditor(tab: vscode.Tab, opened: readonly vscode.Tab[]): boolean {
    if (tab.input instanceof vscode.TabInputTerminal || isWelcomeTab(tab)) {
      return false;
    }
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'vscode-terminal') {
      return false;
    }
    return !opened.some((o) => o.label === tab.label && o.input?.constructor === tab.input?.constructor);
  }
  const closedHistory: (ClosedTab | 'editor')[] = [];
  const CLOSED_HISTORY_MAX = 50;
  function rememberClosed(entry: ClosedTab | 'editor') {
    closedHistory.push(entry);
    if (closedHistory.length > CLOSED_HISTORY_MAX) {
      closedHistory.shift();
    }
  }
  ctx.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        if (reopenableEditor(tab, e.opened)) {
          rememberClosed('editor');
        }
      }
    }),
  );

  /** You renamed a Herdr tab: rename the shell's pane, or the agent, in Herdr to match. */
  async function renamedTabByUser(paneId: string, name: string) {
    const hit = paneOf({ paneId });
    let label = name.trim();
    // An agent's tab shows "Herdr: <name>"; Herdr gets only the name.
    if (hit?.pane.isAgent && label.toLowerCase().startsWith(AGENT_TAB_PREFIX.toLowerCase())) {
      label = label.slice(AGENT_TAB_PREFIX.length).trim();
    }
    if (!hit || !label || !isConnected()) return;
    if (hit.pane.isAgent) {
      // Herdr agent names are identifiers (they're also CLI targets).
      const slug = agentSlug(label);
      if (!slug) return void vscode.window.showWarningMessage(`Herdr: agent names use lowercase letters, digits, - and _; "${label}" stays a VS Code tab name only.`);
      await manage.actions.renameAgent(paneId, slug);
    } else await manage.actions.renamePane(paneId, label);
    log.appendLine(`renamed ${paneId} in Herdr: "${label}" (tab renamed)`);
    kick();
  }

  /** Back after an outage: the space's tabs died with Herdr; offer to open them again. */
  async function offerReopen(lost: { id: string; label: string }) {
    if (!terms.hasExited()) return; // a quick handoff: the tabs survived
    const pick = await vscode.window.showInformationMessage(`Herdr is back. Reopen the tabs for ${lost.label}?`, 'Reopen Tabs');
    if (!pick) return;
    terms.disposeExited();
    // Pane (and possibly space) ids change when Herdr restarts; fall back to the name.
    const sp = model?.spaces.find((s) => s.id === lost.id) ?? model?.spaces.find((s) => s.label === lost.label);
    if (sp) await switchTo(sp);
    else vscode.window.showWarningMessage(`Herdr: "${lost.label}" isn't in Herdr anymore.`);
  }

  /** Start the headless server in the background (it outlives VS Code), then connect. */
  async function startHerdr(): Promise<boolean> {
    if (isConnected()) return true;
    const bin = binary();
    if (!binaryFound(bin)) {
      const pick = await vscode.window.showErrorMessage(`Herdr isn't installed (looked for ${bin}).`, 'Install Herdr', 'Settings');
      if (pick === 'Install Herdr') vscode.commands.executeCommand('herdr.openInstallDocs');
      else if (pick === 'Settings') vscode.commands.executeCommand('herdr.openSettings');
      return false;
    }
    const prev = sync.beginStarting();
    const logFile = vscode.Uri.joinPath(ctx.globalStorageUri, 'herdr-server.log').fsPath;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Herdr…' }, () =>
      startServer(bin, herdrEnvNow(), logFile),
    );
    sync.endStarting(prev);
    if (!r.ok) {
      log.appendLine(`start herdr failed: ${r.error}`);
      const pick = await vscode.window.showErrorMessage(`Herdr: couldn't start the server. ${r.error ?? ''}`, 'Show Log');
      if (pick) vscode.window.showTextDocument(vscode.Uri.file(logFile));
      return false;
    }
    log.appendLine(r.already ? 'herdr was already running' : `started herdr server in the background (log: ${logFile})`);
    await kick();
    return isConnected();
  }

  /** The Cockpit window opened with Herdr stopped: start it, per herdr.startServer (asked once, then remembered). */
  async function maybeAutoStart() {
    if (!isHubWindow() || sync.conn.kind !== 'down' || (sync.conn.reason !== 'not-running' && sync.conn.reason !== 'crashed')) return;
    const mode = cfg().get<'ask' | 'always' | 'never'>('startServer', 'ask');
    if (mode === 'never') return;
    if (mode === 'always') {
      await startHerdr();
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      "Herdr isn't running. Start it in the background whenever the Herdr Cockpit window opens?",
      'Always Start Herdr',
      'Not Now',
      'Never',
    );
    if (pick === 'Always Start Herdr') {
      await cfg().update('startServer', 'always', vscode.ConfigurationTarget.Global);
      await startHerdr();
    } else if (pick === 'Never') await cfg().update('startServer', 'never', vscode.ConfigurationTarget.Global);
  }

  /** Herdr isn't connected: offer to start it. True once connected. */
  async function ensureConnected(): Promise<boolean> {
    if (isConnected()) return true;
    const pick = await vscode.window.showWarningMessage("Herdr isn't running.", 'Start Herdr');
    return pick ? startHerdr() : false;
  }

  // ---------- sidebar ----------
  /** When each space (by name: ids change across Herdr restarts) was last active, kept across reloads. */
  const ACTIVITY_KEY = 'herdr.spaceActivity';
  const spaceActivity = new Map<string, number>(Object.entries(ctx.globalState.get<Record<string, number>>(ACTIVITY_KEY, {})));
  let activitySave: NodeJS.Timeout | undefined;
  function saveActivity() {
    activitySave = undefined;
    const keep = [...spaceActivity].sort((a, b) => b[1] - a[1]).slice(0, 200);
    void ctx.globalState.update(ACTIVITY_KEY, Object.fromEntries(keep));
  }
  function touchSpace(label: string) {
    spaceActivity.set(label, Date.now());
    clearTimeout(activitySave);
    activitySave = setTimeout(saveActivity, 2000);
  }

  function render() {
    for (const sp of model?.spaces ?? []) {
      if (sp.cwd && isMounted(sp)) {
        spaceFolders.set(sp.id, normPath(sp.cwd));
      }
    }
    scheduleHubStatus();
    panel.update(
      buildViewState({
        model,
        showShells: showShells(),
        since: (id) => stateSince.get(id)?.at,
        git,
        mounted: isMounted,
        attached: (id) => terms.has(id),
        activity: (id) => activity.get(id),
        usage,
        connection: { ...(sync.conn as object), kind: sync.conn.kind, expectedProtocol: HERDR_PROTOCOL } as ViewConnection,
        order: cfg().get<'activity' | 'herdr'>('spaceOrder', 'herdr'),
        lastActive: (sp) => spaceActivity.get(sp.label),
        // In the sidebar itself: the secondary sidebar shows a single view as a tab and drops its description.
        versions: { cockpit: String(ctx.extension.packageJSON.version), herdr: sync.conn.kind === 'connected' ? (sync.conn.version ?? undefined) : undefined },
        here: (sp) => isOpenHere(sp),
        needsYou: cfg().get<boolean>('showNeedsYou', true),
      }),
    );
  }
  let renderTimer: NodeJS.Timeout | undefined;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 50);
  }

  // What shells are running and what agents last said, polled only while the sidebar is visible.
  async function pollActivity() {
    if (!model || !panel.visible) return;
    const targets: ActivityTarget[] = model.spaces.flatMap((sp) =>
      sp.tabs.flatMap((t) =>
        t.panes
          .filter((p) => p.isAgent || showShells())
          .map((p): ActivityTarget => ({ paneId: p.id, kind: p.isAgent ? 'agent' : 'shell', status: p.status })),
      ),
    );
    if (await activity.poll(targets)) scheduleRender();
  }
  const activityTimer = setInterval(pollActivity, 4000);

  // Agents' plan usage from their local files: once a minute, only while the sidebar is visible.
  let usage: ProviderUsage[] = [];
  // Live Codex limits start a short-lived `codex app-server`, so ask at most every 5 minutes.
  let codexLive: { at: number; data?: ProviderUsage } = { at: 0 };
  /** Agent kinds running in Herdr right now: only their usage is shown (and read). */
  const runningKinds = () => new Set(model?.spaces.flatMap((s) => s.agents.map((a) => (a.agentKind ?? '').toLowerCase())) ?? []);
  async function pollUsage() {
    if (!panel.visible || !model) return;
    const only = runningKinds();
    if (only.has('codex') && Date.now() - codexLive.at > 5 * 60_000) {
      codexLive = { at: Date.now(), data: await codexLiveUsage(codexBinary(os.homedir())) };
      if (!codexLive.data) log.appendLine('usage: live Codex limits unavailable; using its session logs');
    }
    const opts = { codexLive: codexLive.data, only, kiroMonthlyCredits: cfg().get<number>('kiroMonthlyCredits', 0) };
    const next = await readUsage(os.homedir(), Date.now(), opts).catch((e) => {
      log.appendLine(`usage: ${errorText(e)}`);
      return usage;
    });
    if (JSON.stringify(next) !== JSON.stringify(usage)) {
      usage = next;
      scheduleRender();
    }
  }
  const usageTimer = setInterval(pollUsage, 60_000);

  // Keep git branch/changes fresh even without Herdr events (gitInfo re-renders when they change).
  const redrawTimer = setInterval(() => model && render(), 15000);

  // ---------- applying a new snapshot ----------
  /** Renamed in Herdr (TUI, CLI, sidebar), a new terminal title or herdr.agentNames: rename its tab here too, without focusing it. */
  function syncNames(m: Model) {
    for (const sp of m.spaces)
      for (const tab of sp.tabs)
        for (const p of tab.panes) {
          const n = tabName(tab, p);
          const was = paneNames.get(p.id);
          if (was !== undefined && was !== n && terms.has(p.id)) terms.rename(p.id, n);
          paneNames.set(p.id, n);
        }
  }

  function apply(next: Model) {
    const prev = model;
    model = next;
    syncNames(next);
    renderStatus();

    // Notifications on agent transitions.
    const notifyOn = new Set(cfg().get<string[]>('notifyOn', ['blocked', 'done']));
    const nextStatus = new Map<string, AgentStatus | undefined>();
    for (const sp of next.spaces)
      for (const a of sp.agents) {
        nextStatus.set(a.id, a.status);
        const seen = stateSince.get(a.id);
        if (!seen || seen.status !== a.status) {
          stateSince.set(a.id, { status: a.status, at: Date.now() });
          if (!firstLoad) touchSpace(sp.label); // an agent started, finished, needs you
        }
        const before = lastStatus.get(a.id);
        if (!firstLoad && before && a.status && before !== a.status && notifyOn.has(a.status)) {
          void notify(sp, a).catch(logError('notify'));
        }
      }
    lastStatus = nextStatus;
    // Focused in Herdr or switched to here: recently used.
    const inFocus = next.spaces.find((s) => s.focused);
    if (inFocus && (firstLoad ? !spaceActivity.has(inFocus.label) : prev?.spaces.find((s) => s.focused)?.id !== inFocus.id)) touchSpace(inFocus.label);
    for (const id of [...stateSince.keys()]) if (!nextStatus.has(id)) stateSince.delete(id);

    // Detach VS Code terminals for panes that no longer exist.
    const live = new Set(allPanes(next).map(({ pane }) => pane.id));
    if (live.size > 0) terms.prune(live);

    // Follow mode: Herdr focus moved (e.g. you switched spaces in the Mac terminal).
    const focused = next.focusedSpaceId;
    if (
      !firstLoad &&
      prev &&
      focused &&
      focused !== lastFocusedSpace &&
      !switching &&
      cfg().get<boolean>('followMode', true) &&
      isManagedWindow()
    ) {
      const sp = next.spaces.find((s) => s.id === focused);
      if (sp) {
        log.appendLine(`follow: herdr focused ${sp.label}`);
        void switchTo(sp, { fromHerdr: true }).catch(logError('follow'));
      }
    }
    lastFocusedSpace = focused;
    firstLoad = false;
    render();
    // New panes or a status change deserve fresh activity now, not on the next tick.
    const shape = (m?: Model) => m?.spaces.flatMap((s) => s.agents.map((a) => `${a.id}=${a.status}`).concat(s.tabs.flatMap((t) => t.panes.map((p) => p.id)))).join();
    if (shape(prev) !== shape(next)) pollActivity();
    const kinds = (m?: Model) => [...new Set(m?.spaces.flatMap((s) => s.agents.map((a) => a.agentKind)) ?? [])].sort().join();
    if (kinds(prev) !== kinds(next)) pollUsage();
  }

  /**
   * Every window running this extension sees the same status change. One of them shows it: the focused window
   * first, then a window that has the space, then any other (each waits a little longer before claiming it).
   */
  async function notify(space: Space, agent: Pane) {
    let wait = 2 * NOTIFY_STEP_MS;
    if (vscode.window.state.focused) {
      wait = 0;
    } else if (isOpenHere(space)) {
      wait = NOTIFY_STEP_MS;
    }
    if (wait) {
      await sleep(wait);
    }
    const change = [socketPath(), agent.id, agent.status, agent.raw.agent?.state_change_seq ?? Math.floor(Date.now() / 60_000)].join('\n');
    if (!claimNotification(change)) {
      return;
    }
    const msg = `${agent.label} in ${space.label} is ${agent.status}`;
    const actions = agent.status === 'done' ? ['Review changes', 'Attach'] : ['Attach'];
    const show = agent.status === 'blocked' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await show(`Herdr: ${msg}`, ...actions);
    if (pick === 'Attach') await attachPane(space, agent);
    if (pick === 'Review changes') await review(space, agent);
  }

  function renderStatus() {
    if (!isConnected() || !model) {
      // Nothing current to count: no stale badge or "blocked" color while Herdr is away.
      panel.badge = undefined;
      status.backgroundColor = undefined;
      status.text = sync.conn.kind === 'down' ? '$(debug-disconnect) Herdr' : `$(sync~spin) ${sync.conn.kind === 'starting' ? 'Starting Herdr' : 'Herdr'}`;
      status.tooltip =
        sync.conn.kind === 'down' ? `${DOWN_TEXT[sync.conn.reason]} Click for options.` : sync.conn.kind === 'starting' ? 'Starting Herdr…' : 'Connecting to Herdr…';
      status.command = 'herdr.connectionMenu';
      vscode.commands.executeCommand('setContext', 'herdr.connected', false);
      return;
    }
    vscode.commands.executeCommand('setContext', 'herdr.connected', true);
    const agents = model.spaces.flatMap((s) => s.agents);
    const { blocked, done, working } = countByStatus(model);
    status.text = [
      `$(hubot) ${agents.length}`,
      working ? `$(sync~spin) ${working}` : '',
      blocked ? `$(warning) ${blocked}` : '',
      done ? `$(pass-filled) ${done}` : '',
    ]
      .filter(Boolean)
      .join('  ');
    status.backgroundColor = blocked ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = `Herdr: ${agents.length} agents, ${working} working, ${blocked} blocked, ${done} done.\nClick to jump to the one that needs you.`;
    status.command = 'herdr.focusAttention';
    panel.badge = blocked + done ? { value: blocked + done, tooltip: `${blocked} blocked, ${done} done` } : undefined;
  }

  // ---------- actions ----------
  /**
   * Hand a space (and a pane of it) over to another window through the pending link: the window that opens on
   * `folder`, or the Cockpit window when there's no folder. That window opens the space's tabs once it's up.
   */
  function handOver(space: Space, pane?: Pane, folder?: string) {
    const q = new URLSearchParams({ v: String(LINK_VERSION), space: space.id, label: space.label, ...(pane && { pane: pane.id }) });
    writePendingLink(vscode.env.uriScheme, '/open', q.toString(), undefined, folder);
  }
  /** Review an agent's (or a space's) changes; on a worktree space, the whole branch. */
  function review(space: Space, pane?: Pane) {
    return reviewChanges(pane?.cwd ?? space.cwd, pane?.label ?? space.label, { worktree: !!space.worktree?.is_linked_worktree });
  }
  const warnNoCwd = (space: Space) => void vscode.window.showWarningMessage(`Herdr: no working directory known for space "${space.label}".`);

  async function ensureMounted(space: Space, pin = false): Promise<boolean> {
    const r = await mountSpace(space, pin);
    if (r === 'no-window') {
      const pick = await vscode.window.showWarningMessage(
        'Herdr: open a folder or the Herdr Cockpit window first, so spaces can be mounted next to it.',
        'Set up Cockpit window',
      );
      if (pick) vscode.commands.executeCommand('herdr.setupHub');
      return false;
    }
    if (r === 'no-cwd') {
      warnNoCwd(space);
      return false;
    }
    if (r === 'failed') {
      vscode.window.showErrorMessage(`Herdr: VS Code refused to mount ${space.cwd}.`);
      return false;
    }
    await ctx.workspaceState.update(MANAGED_KEY, true);
    terminalDefaults();
    render();
    return true;
  }

  /**
   * Switching spaces outside the Cockpit window turns the window into an untitled workspace (or adds folders to
   * the user's own workspace). The first time, offer the Cockpit window instead; a window with no folder can't
   * take spaces, so it goes straight to the hub. True: go ahead here.
   */
  async function useThisWindow(space: Space, pane?: Pane): Promise<boolean> {
    if (isHubWindow() || ctx.workspaceState.get<boolean>(THIS_WINDOW_KEY)) return true;
    const toHub = async () => {
      handOver(space, pane);
      await openHub();
      return false;
    };
    if (!vscode.workspace.workspaceFolders?.length) return toHub();
    const wsf = vscode.workspace.workspaceFile;
    const why = !wsf
      ? 'Switching spaces here makes this window an untitled workspace.'
      : wsf.scheme === 'untitled'
        ? 'This window is an untitled workspace.'
        : `Switching spaces here adds folders to your workspace "${vscode.workspace.name}".`;
    const pick = await vscode.window.showInformationMessage(
      `${why} Open the Herdr Cockpit window instead?`,
      { modal: true, detail: "The Cockpit window's first folder never changes, so switching spaces there never restarts your extensions. This window remembers your choice." },
      'Open Cockpit Window',
      'Use This Window',
    );
    if (pick === 'Open Cockpit Window') return toHub();
    if (pick !== 'Use This Window') return false;
    await ctx.workspaceState.update(THIS_WINDOW_KEY, true);
    return true;
  }

  /**
   * herdr.autoAttach. Until it's set, the two settings it replaced (0.3.0) still decide: autoAttachOnSwitch
   * false = none, autoAttachShells false = agents.
   */
  function autoAttachMode(): 'all' | 'agents' | 'none' {
    const set = cfg().inspect<'all' | 'agents' | 'none'>('autoAttach');
    const chosen = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
    if (chosen) {
      return chosen;
    }
    if (cfg().get<boolean>('autoAttachOnSwitch') === false) {
      return 'none';
    }
    if (cfg().get<boolean>('autoAttachShells') === false) {
      return 'agents';
    }
    return 'all';
  }

  const windowMode = () => cfg().get<WindowMode>('windowMode', 'folder');
  const myFolders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => normPath(f.uri.fsPath));
  /** This window is the space's own window: its only folder is the space's. */
  const isOwnWindow = (space: Space) => {
    const folders = myFolders();
    return !!space.cwd && folders.length === 1 && folders[0] === normPath(space.cwd);
  };
  /**
   * The space is open in this window: its folder is one of ours, or we have tabs of it and the folder it had here
   * is still ours (its shell may have moved). Once you remove that folder, the space isn't here anymore, even with
   * its tabs still open, so the next pane you open from it asks again.
   */
  const isOpenHere = (space: Space) => {
    if (isMounted(space)) {
      return true;
    }
    const folder = spaceFolders.get(space.id);
    return terms.spaces().includes(space.id) && !!folder && myFolders().includes(folder);
  };
  const otherWindow = (space: Space) => {
    try {
      return windowWithSpace(space, { scheme: vscode.env.uriScheme, pid: process.pid, socket: socketPath() });
    } catch {
      return undefined;
    }
  };

  /**
   * Open the space in a window of its own: the one that already has it (brought forward), else a new window on
   * its folder (this one, when this window has no folder). The window that opens it attaches the pane through a
   * pending link aimed at that folder.
   */
  async function openInWindow(space: Space, pane?: Pane, win = otherWindow(space)) {
    if (!space.cwd) {
      warnNoCwd(space);
      return;
    }
    // The space lives in that window from now on: close its tabs here (only detaches; the panes keep running in
    // Herdr), so the same pane isn't open twice and this copy doesn't turn read-only when that window takes it.
    terms.closeSpace(space.id);
    const cwd = normPath(space.cwd);
    // Aimed at a folder that window has: the space's, or (matched by label after its folder moved) its first.
    let target = cwd;
    if (win && !win.folders.includes(cwd)) {
      target = win.folders[0];
    }
    handOver(space, pane, target);
    if (win && !win.focus) {
      vscode.window.showInformationMessage(`Herdr: "${space.label}" is open in another window (an untitled workspace). Switch to it from the Window menu.`);
      return;
    }
    const uri = vscode.Uri.file(win?.focus ?? cwd);
    const here = !win && !vscode.workspace.workspaceFolders?.length;
    // An editor brings forward the window that already has this folder or workspace instead of opening another.
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !here });
  }

  /** This window was opened from a workspace file on disk (the Cockpit window, a saved or generated one). */
  const hasWorkspaceFile = () => vscode.workspace.workspaceFile?.scheme === 'file';

  /**
   * Add a space to a window without a workspace file. Adding the folder in place would make it an untitled
   * workspace, which other windows can't bring forward, so this window reopens on a workspace file with its
   * folders plus the space's (~/.herdr-cockpit/workspaces) and opens the space's tabs once it's back, through a
   * pending link aimed at the space's folder. Reopening reloads the window; the panes keep running in Herdr.
   */
  async function reopenWithSpace(space: Space, pane?: Pane) {
    if (!space.cwd) {
      warnNoCwd(space);
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
    } catch (e: any) {
      vscode.window.showErrorMessage(`Herdr: could not write a workspace file for this window: ${errorText(e)}`);
      return;
    }
    handOver(space, pane, space.cwd);
    log.appendLine(`reopening this window on ${file} to add ${space.label}`);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceNewWindow: false });
  }

  /** Record this window's folders and open spaces for the other windows (written only when they change). */
  let lastWindowRecord = '';
  function recordWindow() {
    const me = { scheme: vscode.env.uriScheme, pid: process.pid };
    try {
      const folders = myFolders();
      if (!folders.length) {
        if (lastWindowRecord) removeWindowRecord(me.scheme, me.pid);
        lastWindowRecord = '';
        return;
      }
      const wsf = vscode.workspace.workspaceFile;
      const focus = wsf?.scheme === 'file' ? wsf.fsPath : folders.length === 1 && !wsf ? folders[0] : undefined;
      const spaces = (model?.spaces ?? []).filter(isOpenHere).map((s) => s.label);
      const rec: WindowRecord = { ...me, socket: socketPath(), folders, spaces, ...(focus && { focus }), updated: 0 };
      const key = JSON.stringify(rec);
      if (key === lastWindowRecord) return;
      lastWindowRecord = key;
      writeWindowRecord({ ...rec, updated: Date.now() });
    } catch (e: any) {
      log.appendLine(`could not record this window: ${errorText(e)}`);
    }
  }

  /** Ask where a space this window doesn't have goes; "Always…" is remembered for this window. */
  async function askPlacement(space: Space, pane?: Pane): Promise<Placement | undefined> {
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
    if (pick?.remember) await ctx.workspaceState.update(PLACE_KEY, pick.place);
    return pick?.place;
  }

  /**
   * Before switching to a space: 'here' = switch this window, 'add' = mount it next to this window's folders,
   * 'elsewhere' = another window has it or gets it (or you cancelled). `how` is an explicit choice (right-click).
   */
  async function placeSpace(space: Space, pane?: Pane, how?: Placement): Promise<'here' | 'add' | 'stay' | 'elsewhere'> {
    const decision = decidePlacement({
      how,
      pane: !!pane,
      mode: windowMode(),
      ownWindow: isOwnWindow(space),
      openHere: isOpenHere(space),
      mounted: isMounted(space),
      otherWindow: !!otherWindow(space),
      hasFolders: !!vscode.workspace.workspaceFolders?.length,
      remembered: ctx.workspaceState.get<Placement>(PLACE_KEY),
    });
    let choice: Placement | undefined;
    switch (decision) {
      case 'here':
      case 'add':
      case 'stay':
        return decision;
      case 'askHub':
        if (await useThisWindow(space, pane)) {
          return 'here';
        }
        return 'elsewhere';
      case 'window':
        await openInWindow(space, pane);
        return 'elsewhere';
      case 'ask':
        choice = await askPlacement(space, pane);
        if (choice === 'workspace') {
          return 'add';
        }
        if (choice === 'window') {
          await openInWindow(space, pane);
        }
        return 'elsewhere';
    }
  }

  /**
   * The editor's Welcome / walkthrough page is in the way once a space is open: close it. The tab API shows
   * it as a tab without an input (like other built-in editors), so it's recognized by its label.
   */
  function closeWelcome() {
    const welcome = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isWelcomeTab);
    if (welcome.length) vscode.window.tabGroups.close(welcome).then(undefined, () => undefined);
  }

  /** False when the switch didn't happen in this window (handed to another window, cancelled, or the folder couldn't be mounted). */
  async function switchTo(space: Space, opts: { fromHerdr?: boolean; pin?: boolean; autoAttach?: boolean; pane?: Pane; place?: Placement } = {}): Promise<boolean> {
    if (opts.fromHerdr) {
      if (!followsInto({ otherWindow: !!otherWindow(space), mode: windowMode(), hub: isHubWindow(), mounted: isMounted(space) })) {
        return false;
      }
    } else {
      const where = await placeSpace(space, opts.pane, opts.place);
      if (where === 'elsewhere') return false;
      if (where === 'stay') {
        return true;
      }
      if (where === 'add') opts = { ...opts, pin: true };
      if (where === 'add' && !isMounted(space) && !hasWorkspaceFile()) {
        await reopenWithSpace(space, opts.pane);
        return false;
      }
    }
    switching = true;
    try {
      if (!(await ensureMounted(space, !!opts.pin))) {
        return false;
      }
      closeWelcome();
      if (space.cwd && cfg().get<boolean>('revealInExplorer', false)) {
        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(space.cwd)).then(undefined, () => {});
      }
      if (!opts.fromHerdr) {
        await client.request('workspace.focus', { workspace_id: space.id }).catch((e) => log.appendLine(`workspace.focus: ${e.message}`));
        lastFocusedSpace = space.id; // don't let follow-mode bounce us
      }
      if (!opts.pin && cfg().get<boolean>('closeTerminalsOnSwitch', true)) terms.closeOtherSpaces(space.id);
      const mode = autoAttachMode();
      if (opts.autoAttach ?? mode !== 'none') {
        // Every pane gets its own tab: agents (most urgent first), then shells in Herdr's tab order.
        // Tabs appear in the order they're opened (editor and panel alike): open all, then focus the first.
        const panes = attachOrder(space, mode === 'all');
        // Following Herdr, a pane another editor's Cockpit window has stays with it (shown read-only here).
        const polite = !!opts.fromHerdr;
        for (const p of panes) terms.attach(p, { preserveFocus: true, polite });
        if (panes[0]) terms.attach(panes[0], { polite });
      }
    } finally {
      switching = false;
    }
    return true;
  }

  // ---------- another client took a pane over ----------
  // The tabs keep showing their panes read-only (builtinTerminal.ts). Say so once for the panes lost together
  // (a space switch in another window takes all of them).
  const takenOver = new Map<string, string | undefined>();
  let takenOverTimer: NodeJS.Timeout | undefined;
  function tookOver(paneId: string, who: string | undefined) {
    if (!cfg().get<boolean>('notifyOnTakeover', true)) return;
    takenOver.set(paneId, who);
    clearTimeout(takenOverTimer);
    takenOverTimer = setTimeout(() => void showTakenOver(), 600);
  }
  async function showTakenOver() {
    const lost = [...takenOver];
    takenOver.clear();
    if (!lost.length) return;
    const whos = [...new Set(lost.map(([, w]) => w ?? 'another Herdr client'))];
    const who = whos.length === 1 ? whos[0] : 'other Herdr clients';
    const names = lost.map(([paneId]) => terms.nameOf(paneId) ?? paneId);
    const list = names.length === 1 ? names[0] : names.length <= 3 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    const one = names.length === 1;
    const pick = await vscode.window.showWarningMessage(
      `${who[0].toUpperCase()}${who.slice(1)} took over the Herdr ${one ? 'pane' : 'panes'} ${list}. ${one ? 'Its tab shows it' : 'Their tabs show them'} read-only here; type in a tab to take it back.`,
      'Take Back',
      "Don't Show Again",
    );
    if (pick === 'Take Back') terms.takeBack(lost.map(([paneId]) => paneId));
    else if (pick === "Don't Show Again") await cfg().update('notifyOnTakeover', false, vscode.ConfigurationTarget.Global);
  }

  async function attachPane(space: Space, pane: Pane, startingAs?: string) {
    if (!terms.has(pane.id) && space.cwd && !(await switchTo(space, { autoAttach: false, pane }))) return;
    terms.attach(pane, { startingAs });
    if (pane.isAgent) client.request('agent.focus', { target: pane.id }).catch(() => {});
  }

  const paneOf = (t?: Target): { space: Space; pane: Pane } | undefined => findPane(model, t?.paneId);
  const spaceFrom = async (t?: Target): Promise<Space | undefined> => {
    const hit = model?.spaces.find((s) => s.id === t?.spaceId) ?? paneOf(t)?.space;
    if (hit) return hit;
    if (!isConnected()) {
      if (await ensureConnected()) return spaceFrom(t);
      return;
    }
    if (!model?.spaces.length) {
      vscode.window.showWarningMessage('Herdr: no spaces yet. Create one with the + next to Spaces.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      model.spaces.map((s) => ({ label: s.label, description: [s.status, s.cwd].filter(Boolean).join(' · '), s })),
      { title: 'Switch to Herdr space' },
    );
    return pick?.s;
  };

  /** Pick an agent or shell from every space (only agents with `agentsOnly`). Undefined when cancelled. */
  async function pickPane(title: string, agentsOnly = false): Promise<{ space: Space; pane: Pane } | undefined> {
    if (!isConnected() && !(await ensureConnected())) {
      return undefined;
    }
    const all = allPanes(model).filter(({ pane }) => pane.isAgent || (!agentsOnly && showShells()));
    if (!all.length) {
      vscode.window.showInformationMessage(agentsOnly ? 'Herdr: no agents running.' : 'Herdr: no panes yet.');
      return undefined;
    }
    // Agents first, the ones waiting on you on top; shells after them, in Herdr's order.
    const waiting = needingAttention(model).map((x) => x.pane.id);
    const rank = (p: Pane) => {
      const i = waiting.indexOf(p.id);
      if (i >= 0) {
        return i;
      }
      if (p.isAgent) {
        return waiting.length;
      }
      return waiting.length + 1;
    };
    const sorted = all.map((x, i) => ({ ...x, i })).sort((a, b) => rank(a.pane) - rank(b.pane) || a.i - b.i);
    type Item = vscode.QuickPickItem & { hit: { space: Space; pane: Pane } };
    const items: Item[] = sorted.map(({ space, pane }) => {
      const tab = space.tabs.find((t) => t.id === pane.tabId);
      const parts = [space.label];
      if (pane.isAgent && pane.status) {
        parts.push(pane.status);
      }
      if (terms.has(pane.id)) {
        parts.push('open');
      }
      return {
        label: paneName(tab, pane),
        description: parts.join(' · '),
        iconPath: agentIcon(pane.isAgent ? pane.agentKind : undefined) ?? new vscode.ThemeIcon(pane.isAgent ? 'hubot' : 'terminal'),
        hit: { space, pane },
      };
    });
    const pick = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    return pick?.hit;
  }

  /** The agent a command acts on: the one clicked, the agent tab you're in, or pick one. */
  async function agentFrom(t: Target | undefined, title: string): Promise<{ space: Space; pane: Pane } | undefined> {
    const clicked = paneOf(t);
    if (clicked?.pane.isAgent) {
      return clicked;
    }
    const here = paneOf({ paneId: terms.paneOf(vscode.window.activeTerminal)?.paneId });
    if (!t && here?.pane.isAgent) {
      return here;
    }
    return pickPane(title, true);
  }

  /** Send a prompt to an agent, as if you typed it in its pane and pressed Enter. */
  async function promptAgent(hit: { space: Space; pane: Pane }, text: string) {
    const name = paneName(hit.space.tabs.find((t) => t.id === hit.pane.tabId), hit.pane);
    try {
      await manage.actions.promptAgent(hit.pane.id, text);
      vscode.window.setStatusBarMessage(`Herdr: sent to ${name}`, 3000);
      log.appendLine(`prompted ${hit.pane.id} (${text.length} characters)`);
      kick();
    } catch (e) {
      vscode.window.showErrorMessage(`Herdr: couldn't send to ${name}: ${errorText(e)}`);
    }
  }

  /** `src/app.ts:12-30` for a selection, relative to the agent's folder when the file is inside it. */
  function fileReference(editor: vscode.TextEditor, agentCwd: string | undefined): string {
    const file = editor.document.uri.fsPath;
    let shown = file;
    if (agentCwd) {
      const rel = path.relative(agentCwd, file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        shown = rel;
      }
    }
    const sel = editor.selection;
    if (sel.isEmpty) {
      return shown;
    }
    let last = sel.end.line;
    // A selection ending at the start of a line doesn't include that line.
    if (sel.end.character === 0 && last > sel.start.line) {
      last--;
    }
    if (last === sel.start.line) {
      return `${shown}:${sel.start.line + 1}`;
    }
    return `${shown}:${sel.start.line + 1}-${last + 1}`;
  }

  // ---------- create / rename / close ----------
  /** Herdr's agent manifests, asked once per connection (they change only with a Herdr update). */
  let agentKindsCache: { version?: string; kinds: Promise<string[]> } | undefined;
  function herdrAgentKinds(): Promise<string[]> {
    const version = sync.conn.kind === 'connected' ? sync.conn.version : undefined;
    if (!agentKindsCache || agentKindsCache.version !== version) {
      const kinds = new HerdrActions(client).agentKinds().catch((e) => {
        log.appendLine(`agent manifests: ${errorText(e)}`);
        agentKindsCache = undefined; // ask again next time
        return [];
      });
      agentKindsCache = { version, kinds };
    }
    return agentKindsCache.kinds;
  }
  const manage: ManageDeps = {
    actions: new HerdrActions(client),
    async findPane(paneId) {
      for (let i = 0; i < 15; i++) {
        await refresh();
        const hit = paneOf({ paneId });
        if (hit) return hit;
        await sleep(200);
      }
    },
    attach: attachPane,
    agentIcon,
    spaces: () => model?.spaces ?? [],
    branchOf: (cwd) => {
      const g = git(cwd);
      return g && !g.detached ? g.branch : undefined;
    },
    agentNames: () => model?.spaces.flatMap((s) => s.agents.map((a) => a.raw.agent?.name).filter((n): n is string => !!n)) ?? [],
    agents: () => cfg().get<string[]>('agents', ['claude', 'codex', 'kiro', 'cursor']),
    herdrAgentKinds: () => herdrAgentKinds(),
    renameTerminal: async (paneId, name) => terms.rename(paneId, name),
    ensureConnected: () => ensureConnected(),
    log: (m) => log.appendLine(m),
  };
  /** A space or pane from a sidebar/context-menu target. */
  const itemOf = (t?: Target): { space: Space; pane?: Pane } | undefined => {
    const space = model?.spaces.find((s) => s.id === t?.spaceId);
    return paneOf(t) ?? (space && { space });
  };

  /** Right-click "Open/Attach in its own window" or "Add/Attach in this window": a space opens all its panes, a pane just itself. */
  async function placeIn(t: Target | undefined, place: Placement) {
    const it = itemOf(t);
    if (!it) {
      return;
    }
    const placed = await switchTo(it.space, { pane: it.pane, place, autoAttach: !it.pane });
    if (placed && it.pane) {
      await attachPane(it.space, it.pane);
    }
  }

  /** Where a "+" terminal goes: the space of the Herdr terminal you're in, the one mounted space, Herdr's focused space, or ask. */
  async function targetSpace(): Promise<Space | undefined> {
    if (!model) await refresh();
    if (!model) return;
    const mounted = model.spaces.filter(isMounted);
    const id = terms.spaceOf(vscode.window.activeTerminal) ?? (mounted.length === 1 ? mounted[0].id : undefined) ?? model.focusedSpaceId;
    return model.spaces.find((s) => s.id === id) ?? (await spaceFrom());
  }

  ctx.subscriptions.push(
    registerProfiles({
      ...manage,
      targetSpace,
      newPty: (target) => terms.newPty(target),
      adopt: (paneId, spaceId, term, pty, name) => terms.adopt(paneId, spaceId, term, pty, name),
      paneOf: (term) => terms.paneOf(term),
      startHerdr: () => startHerdr(),
    }),
    log,
    panel,
    vscode.window.registerWebviewViewProvider(HerdrPanel.viewId, panel),
    panel.onDidChangeVisibility((visible) => {
      if (!visible) return;
      if (!isConnected()) kick();
      render();
      pollActivity();
      pollUsage();
    }),
    vscode.window.onDidChangeWindowState((w) => w.focused && !isConnected() && kick()),
    status,
    terms,
    {
      dispose: () => {
        sync.dispose();
        clearTimeout(renderTimer);
        clearTimeout(takenOverTimer);
        clearInterval(redrawTimer);
        clearInterval(activityTimer);
        clearInterval(usageTimer);
        // A pending write of the space order would be lost with the window.
        if (activitySave) {
          clearTimeout(activitySave);
          saveActivity();
        }
      },
    },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('herdr')) return;
      if (e.affectsConfiguration('herdr.agentNames')) {
        setAgentNames(cfg().get<AgentNames>('agentNames', 'title'));
        if (model) {
          syncNames(model);
        }
      }
      if (e.affectsConfiguration('herdr.socketPath')) {
        // Another session: watch its socket folder, take its events instead of the old one's, and connect now.
        void sync.socketChanged();
      }
      render();
      if (e.affectsConfiguration('herdr.showShellPanes')) pollActivity();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => render()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => render()),

    vscode.commands.registerCommand('herdr.refresh', () => kick()),
    vscode.commands.registerCommand('herdr.startServer', () => startHerdr()),
    vscode.commands.registerCommand('herdr.openInstallDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://herdr.dev'))),
    vscode.commands.registerCommand('herdr.copyDiagnostics', async () => {
      const st = await serverStatus(binary(), herdrEnvNow());
      const text = [
        `Herdr Cockpit ${ctx.extension.packageJSON.version} · VS Code ${vscode.version} · ${process.platform}`,
        `connection: ${JSON.stringify(sync.conn)}`,
        `binary: ${binary()} (${binaryFound(binary()) ? 'found' : 'NOT FOUND'})`,
        `socket: ${socketPath()}${cfg().get<string>('socketPath') ? ' (herdr.socketPath)' : ''} (${fs.existsSync(socketPath()) ? 'exists' : 'missing'})`,
        `herdr status server: ${st ? JSON.stringify(st) : 'no answer'}`,
        `expected protocol: ${HERDR_PROTOCOL}`,
      ].join('\n');
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Herdr Cockpit: diagnostics copied to the clipboard.');
    }),
    vscode.commands.registerCommand('herdr.connectionMenu', async () => {
      if (isConnected()) return vscode.commands.executeCommand('herdr.focusAttention');
      const conn = sync.conn;
      const down = conn.kind === 'down' ? conn : undefined;
      type Item = vscode.QuickPickItem & { cmd: string };
      const items: Item[] = [
        ...(down?.reason === 'not-installed'
          ? [{ label: '$(link-external) Install Herdr', cmd: 'herdr.openInstallDocs' }]
          : [{ label: '$(play) Start Herdr', description: 'in the background', cmd: 'herdr.startServer' }]),
        { label: '$(window) Open Herdr TUI', cmd: 'herdr.openTui' },
        { label: '$(refresh) Retry', cmd: 'herdr.refresh' },
        { label: '$(copy) Copy Diagnostics', cmd: 'herdr.copyDiagnostics' },
        { label: '$(settings-gear) Settings', cmd: 'herdr.openSettings' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: down ? DOWN_TEXT[down.reason] : 'Connecting to Herdr…' });
      if (pick) vscode.commands.executeCommand(pick.cmd);
    }),

    vscode.commands.registerCommand('herdr.switchSpace', async (t?: Target) => {
      const sp = await spaceFrom(t);
      if (sp) await switchTo(sp);
    }),
    // Space cards say Open / Add, pane rows say Attach (a menu label is per command); both run placeIn.
    vscode.commands.registerCommand('herdr.openInOwnWindow', (t?: Target) => placeIn(t, 'window')),
    vscode.commands.registerCommand('herdr.addToWorkspace', (t?: Target) => placeIn(t, 'workspace')),
    vscode.commands.registerCommand('herdr.attachInSpaceWindow', (t?: Target) => placeIn(t, 'window')),
    vscode.commands.registerCommand('herdr.attachInThisWindow', (t?: Target) => placeIn(t, 'workspace')),
    vscode.commands.registerCommand('herdr.askWhereToOpenSpaces', async () => {
      await ctx.workspaceState.update(PLACE_KEY, undefined);
      vscode.window.setStatusBarMessage('Herdr: this window will ask where to open spaces again', 2500);
    }),
    vscode.commands.registerCommand('herdr.unmountSpace', async (t?: Target) => {
      const sp = await spaceFrom(t);
      if (sp) {
        await unmountSpace(sp);
        render();
      }
    }),
    vscode.commands.registerCommand('herdr.attach', async (t?: Target) => {
      const hit = paneOf(t) ?? (await pickPane('Go to a Herdr agent or shell'));
      if (hit) {
        await attachPane(hit.space, hit.pane);
      }
    }),
    vscode.commands.registerCommand('herdr.goToPane', async () => {
      const hit = await pickPane('Go to a Herdr agent or shell');
      if (hit) {
        await attachPane(hit.space, hit.pane);
      }
    }),
    vscode.commands.registerCommand('herdr.promptAgent', async (t?: Target) => {
      const hit = await agentFrom(t, 'Send a prompt to which agent?');
      if (!hit) {
        return;
      }
      const name = paneName(hit.space.tabs.find((x) => x.id === hit.pane.tabId), hit.pane);
      const text = await vscode.window.showInputBox({
        title: `Prompt ${name} (${hit.space.label})`,
        prompt: hit.pane.status === 'working' ? `${name} is working: the agent gets this when it reads its input.` : 'Sent as if you typed it in its tab and pressed Enter.',
        placeHolder: 'e.g. run the tests and fix what fails',
        validateInput: (v) => {
          if (v.trim()) {
            return undefined;
          }
          return 'Enter a prompt';
        },
      });
      if (text?.trim()) {
        await promptAgent(hit, text.trim());
      }
    }),
    vscode.commands.registerCommand('herdr.sendToAgent', async (uri?: vscode.Uri) => {
      // From the editor (selection or whole file) or the Explorer's right-click (a file).
      let editor = vscode.window.activeTextEditor;
      if (uri && editor?.document.uri.toString() !== uri.toString()) {
        editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
      }
      if (!editor) {
        vscode.window.showInformationMessage('Herdr: open a file first.');
        return;
      }
      const hit = await agentFrom(undefined, 'Send to which agent?');
      if (!hit) {
        return;
      }
      const ref = fileReference(editor, hit.pane.cwd ?? hit.space.cwd);
      const name = paneName(hit.space.tabs.find((x) => x.id === hit.pane.tabId), hit.pane);
      const ask = await vscode.window.showInputBox({
        title: `Send ${ref} to ${name}`,
        prompt: `What should ${name} do with it? The prompt ends with "(see ${ref})".`,
        placeHolder: 'e.g. explain this, or add tests for it',
        validateInput: (v) => {
          if (v.trim()) {
            return undefined;
          }
          return 'Say what the agent should do';
        },
      });
      if (ask?.trim()) {
        await promptAgent(hit, `${ask.trim()} (see ${ref})`);
      }
    }),
    vscode.commands.registerCommand('herdr.reviewChanges', async (t?: Target) => {
      const hit = paneOf(t);
      if (hit) return review(hit.space, hit.pane);
      const sp = await spaceFrom(t);
      if (sp) await review(sp);
    }),
    vscode.commands.registerCommand('herdr.toggleShellPanes', () =>
      cfg().update('showShellPanes', !showShells(), vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand('herdr.openHelp', () => showHelp(ctx)),
    vscode.commands.registerCommand('herdr.setKiroCredits', async () => {
      const current = cfg().get<number>('kiroMonthlyCredits', 0);
      const v = await vscode.window.showInputBox({
        title: 'Kiro monthly credits',
        prompt: "Your plan's monthly credit allowance (Kiro shows it in /usage). 0 hides the bar.",
        value: current ? String(current) : '',
        validateInput: (s) => (s.trim() === '' || (Number.isFinite(Number(s)) && Number(s) >= 0) ? undefined : 'Enter a number'),
      });
      if (v === undefined) return;
      await cfg().update('kiroMonthlyCredits', Number(v) || 0, vscode.ConfigurationTarget.Global);
      pollUsage();
    }),
    vscode.commands.registerCommand('herdr.setupClaudeUsage', async () => {
      if (await setUpClaudeUsage(os.homedir(), (m) => log.appendLine(m))) pollUsage();
    }),
    vscode.commands.registerCommand('herdr.newSpace', () => newSpace(manage)),
    vscode.commands.registerCommand('herdr.newTab', async (t?: Target) => {
      // From the keyboard there's no target: use the space you're working in, like a "+" terminal.
      let sp: Space | undefined;
      if (t) {
        sp = await spaceFrom(t);
      } else {
        sp = await targetSpace();
      }
      if (sp) await newTab(manage, sp);
    }),
    vscode.commands.registerCommand('herdr.reopenClosedTab', async () => {
      const last = closedHistory.pop();
      if (last === undefined || last === 'editor') {
        await vscode.commands.executeCommand('workbench.action.reopenClosedEditor');
        return;
      }
      log.appendLine(`reopening closed tab ${last.paneId} (${last.closedInHerdr ? 'closed in Herdr' : 'detached'})`);
      await reopenTab(manage, last);
    }),
    vscode.commands.registerCommand('herdr.rename', async (t?: Target) => {
      const it = itemOf(t);
      if (it) await rename(manage, it);
    }),
    vscode.commands.registerCommand('herdr.closeInHerdr', async (t?: Target) => {
      const it = itemOf(t);
      if (it) await closeInHerdr(manage, it);
    }),
    vscode.commands.registerCommand('herdr.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`),
    ),
    vscode.commands.registerCommand('herdr.showRaw', async (t?: Target) => {
      const hit = paneOf(t) ?? (t ? undefined : await pickPane('Show the raw Herdr record of'));
      const raw = hit ? { pane: hit.pane.raw.pane, agent: hit.pane.raw.agent, activity: activity.get(hit.pane.id) } : model?.spaces.find((s) => s.id === t?.spaceId)?.raw;
      if (!raw) return;
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(raw, null, 2) });
      vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('herdr.focusAttention', async () => {
      if (!model) {
        return refresh();
      }
      // Blocked agents first, then done ones; again from one of them goes to the next, and around.
      const waiting = needingAttention(model);
      if (!waiting.length) {
        vscode.window.showInformationMessage('Herdr: no agent needs attention right now.');
        return;
      }
      const current = terms.paneOf(vscode.window.activeTerminal)?.paneId;
      const i = waiting.findIndex((x) => x.pane.id === current);
      const next = waiting[(i + 1) % waiting.length];
      await attachPane(next.space, next.pane);
    }),
    vscode.commands.registerCommand('herdr.openTui', () => {
      const t = vscode.window.createTerminal({
        name: 'herdr',
        shellPath: binary(),
        iconPath: new vscode.ThemeIcon('layout-sidebar-left'),
        location: { viewColumn: vscode.ViewColumn.Active },
      });
      t.show();
      setTimeout(() => kick(), 1500);
    }),
    vscode.commands.registerCommand('herdr.toggleFollow', async () => {
      const on = !cfg().get<boolean>('followMode', true);
      await cfg().update('followMode', on, vscode.ConfigurationTarget.Global);
      if (on) await ctx.workspaceState.update(MANAGED_KEY, true);
      vscode.window.setStatusBarMessage(`Herdr follow mode ${on ? 'on' : 'off'}`, 2500);
      render();
    }),
    vscode.commands.registerCommand('herdr.setupHub', async () => {
      await openHub();
    }),
    vscode.commands.registerCommand('herdr.installPlugin', () => {
      // Herdr previews what the plugin runs and asks before installing; the user confirms in this terminal.
      const t = vscode.window.createTerminal({ name: 'Install Herdr plugin', iconPath: new vscode.ThemeIcon('extensions') });
      t.show();
      t.sendText(`${shellQuote(binary())} plugin install ${PLUGIN_SOURCE}`, true);
    }),
    vscode.commands.registerCommand('herdr.dumpSnapshot', async () => {
      try {
        const raw = await client.request('session.snapshot');
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(raw, null, 2) });
        vscode.window.showTextDocument(doc);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Herdr: ${e.message}`);
      }
    }),
  );

  // ---------- Cockpit window, deep links, files for the Herdr plugin (hubFiles.ts) ----------
  const scheme = vscode.env.uriScheme;
  const extensionVersion: string = ctx.extension.packageJSON.version;

  /** Create the hub workspace if needed and open it (an editor focuses it if it's already open). */
  async function openHub(newWindow = true) {
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

  /** The Herdr session this window talks to; undefined = the default session. */
  const currentSession = () => sessionOfSocket(socketPath());

  /**
   * A link from the Herdr plugin (or anywhere: links are validated in parseLink and can only pick a space,
   * pane or file). Links act in the Cockpit window; another window hands them over and opens the hub.
   */
  async function handleLink(uri: vscode.Uri) {
    let req: LinkRequest;
    try {
      req = parseLink(uri.path, uri.query);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Herdr Cockpit: can't open this link: ${e.message}.`);
      return;
    }
    if (!isHubWindow()) {
      writePendingLink(scheme, uri.path, uri.query);
      await openHub();
      return;
    }
    await runLink(req);
  }

  async function runLink(req: LinkRequest) {
    log.appendLine(`link: ${req.kind} ${JSON.stringify(req)}`);
    if (req.session !== undefined && req.session !== currentSession()) {
      const pick = await vscode.window.showWarningMessage(
        `This link is for the Herdr session "${req.session}", but Herdr Cockpit is connected to ${currentSession() ? `"${currentSession()}"` : 'the default session'}.`,
        `Switch to "${req.session}"`,
      );
      if (!pick) return;
      await cfg().update('socketPath', sessionSocketPath(req.session), vscode.ConfigurationTarget.Global);
      await kick();
    }
    if (req.kind === 'file') {
      // Files in your spaces, panes or open folders open directly; anything else asks.
      const roots = [
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        ...(model?.spaces ?? []).map((s) => s.cwd),
        ...allPanes(model).map(({ pane }) => pane.cwd),
      ].filter((r): r is string => !!r && r !== '/' && r !== os.homedir());
      if (!isInsideRoots(req.path, roots)) {
        const ok = await vscode.window.showWarningMessage(
          `A link asks to open ${req.path}, which isn't in a Herdr space or an open folder.`,
          { modal: true },
          'Open',
        );
        if (ok !== 'Open') return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.path)).then(undefined, () => undefined);
      if (!doc) return void vscode.window.showWarningMessage(`Herdr Cockpit: can't open ${req.path}.`);
      const pos = new vscode.Position(Math.max(0, (req.line ?? 1) - 1), Math.max(0, (req.col ?? 1) - 1));
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
      return;
    }
    if (!isConnected()) await kick();
    if (!isConnected() && !(await ensureConnected())) return;
    const hit = req.pane ? paneOf({ paneId: req.pane }) : undefined;
    const sp = hit?.space ?? model?.spaces.find((s) => s.id === req.space) ?? (req.label ? model?.spaces.find((s) => s.label === req.label) : undefined);
    vscode.commands.executeCommand('herdr.spaces.focus').then(undefined, () => {});
    if (!sp) {
      if (req.space || req.label || req.pane) vscode.window.showWarningMessage(`Herdr Cockpit: that space or pane isn't in Herdr anymore.`);
      return;
    }
    if (req.kind === 'review') return review(sp, hit?.pane);
    await ctx.workspaceState.update(MANAGED_KEY, true);
    if (terms.spaces()[0] !== sp.id || !isMounted(sp)) await switchTo(sp);
    if (hit) await attachPane(sp, hit.pane);
  }

  // ---------- the built-in tabs' own commands: find, scrolling the history, output, file links ----------

  /** `herdr.terminalActive`: the focused terminal is a Herdr tab (its keybindings apply). */
  const terminalContext = () => void vscode.commands.executeCommand('setContext', 'herdr.terminalActive', !!terms.ptyOf(vscode.window.activeTerminal));
  const tabAction = (a: TabAction) => () => {
    const pty = terms.ptyOf(vscode.window.activeTerminal);
    if (pty) pty.action(a);
    else void vscode.window.showInformationMessage('Focus a Herdr terminal tab first.');
  };
  /** Opening a file from a tab in the editor area puts it beside the tab, not over it. */
  const besideTerminal = () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
  type FileLink = vscode.TerminalLink & { uri: vscode.Uri; line?: number; col?: number };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(terminalContext),
    vscode.window.onDidOpenTerminal(() => setTimeout(terminalContext, 200)), // adopted a moment after it opens
    vscode.commands.registerCommand('herdr.terminal.find', tabAction('find')),
    vscode.commands.registerCommand('herdr.terminal.findNext', tabAction('find-next')),
    vscode.commands.registerCommand('herdr.terminal.findPrevious', tabAction('find-previous')),
    vscode.commands.registerCommand('herdr.terminal.pageUp', tabAction('page-up')),
    vscode.commands.registerCommand('herdr.terminal.pageDown', tabAction('page-down')),
    vscode.commands.registerCommand('herdr.terminal.scrollToTop', tabAction('top')),
    vscode.commands.registerCommand('herdr.terminal.scrollToBottom', tabAction('bottom')),
    vscode.commands.registerCommand('herdr.terminal.openOutput', tabAction('output')),
    vscode.window.registerTerminalLinkProvider({
      // `src/foo.ts:42` printed in a pane, resolved against the pane's folder (the editor's own links don't know it).
      async provideTerminalLinks(context) {
        const at = terms.paneOf(context.terminal);
        if (!at) return [];
        const hit = paneOf({ paneId: at.paneId });
        const bases = [...new Set([hit?.pane.cwd, hit?.space.cwd].filter((d): d is string => !!d))];
        const links: FileLink[] = [];
        for (const ref of findFileRefs(context.line).slice(0, 50)) {
          const p = ref.path.startsWith('~/') ? path.join(os.homedir(), ref.path.slice(2)) : ref.path;
          for (const base of path.isAbsolute(p) ? [''] : bases) {
            const file = path.resolve(base, p);
            const st = await fs.promises.stat(file).catch(() => undefined);
            if (!st?.isFile()) continue;
            links.push({ startIndex: ref.start, length: ref.length, tooltip: `Open ${ref.path}${ref.line ? ` at line ${ref.line}` : ''}`, uri: vscode.Uri.file(file), line: ref.line, col: ref.col });
            break;
          }
        }
        return links;
      },
      async handleTerminalLink(l) {
        const link = l as FileLink;
        const pos = new vscode.Position(Math.max(0, (link.line ?? 1) - 1), Math.max(0, (link.col ?? 1) - 1));
        await vscode.window.showTextDocument(link.uri, { viewColumn: besideTerminal(), preview: false, ...(link.line && { selection: new vscode.Range(pos, pos) }) });
      },
    }),
  );
  terminalContext();

  ctx.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => void handleLink(uri).catch(logError('link failed')) }),
  );

  /** A link handed over by another window of this editor: to the Cockpit window, or to the window with its folder. */
  function takeHandoff() {
    const p = takePendingLink(scheme, undefined, undefined, (folder) => (folder ? myFolders().includes(folder) : isHubWindow()));
    if (!p) return;
    try {
      runLink(parseLink(p.path, p.query)).catch(logError('link failed'));
    } catch {
      // validated before it was written; a stale or edited file is ignored
    }
  }
  let handoffWatch: fs.FSWatcher | undefined;
  if (isHubWindow() || vscode.workspace.workspaceFolders?.length)
    try {
      fs.mkdirSync(hubDir(), { recursive: true }); // a pre-rename Cockpit window may not have it yet
      handoffWatch = fs.watch(hubDir(), (_e, name) => {
        if (name === 'pending-link.json') setTimeout(takeHandoff, 100);
      });
    } catch {
      // no hub folder yet
    }

  // Tell the Herdr plugin this editor has Herdr Cockpit, and how to start it from a terminal.
  try {
    let applicationName: string | undefined;
    try {
      applicationName = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).applicationName;
    } catch {
      // no product.json: fall back to `code`
    }
    writeEditorRecord({
      name: vscode.env.appName,
      scheme,
      cli: editorCli(vscode.env.appRoot, applicationName),
      extensionId: ctx.extension.id,
      extensionVersion,
      linkVersion: LINK_VERSION,
      platform: process.platform,
      updated: Date.now(),
    });
  } catch (e: any) {
    log.appendLine(`could not write the editor record: ${errorText(e)}`);
  }
  try {
    pruneClaims();
  } catch {
    // best effort
  }

  // The Cockpit window's state, for the plugin's status pane: written on change, plus a heartbeat.
  let lastHubStatus = '';
  let hubStatusAt = 0;
  function writeStatusNow() {
    recordWindow();
    if (!isHubWindow()) return;
    const { working, blocked, done, idle } = countByStatus(model);
    const counts = { working, blocked, done, idle };
    const attached = terms.spaces()[0];
    const s: Omit<HubStatus, 'updated'> = {
      editor: vscode.env.appName,
      scheme,
      pid: process.pid,
      connected: isConnected(),
      state: sync.conn.kind === 'down' ? sync.conn.reason : sync.conn.kind,
      session: currentSession(),
      space: model?.spaces.find((x) => x.id === attached)?.label,
      tabs: terms.count(),
      agents: counts,
      extensionVersion,
    };
    const key = JSON.stringify(s);
    if (key === lastHubStatus && Date.now() - hubStatusAt < 30_000) return;
    lastHubStatus = key;
    hubStatusAt = Date.now();
    try {
      writeHubStatus({ ...s, updated: hubStatusAt });
    } catch {
      // best effort
    }
  }
  let hubStatusTimer: NodeJS.Timeout | undefined;
  scheduleHubStatus = () => {
    clearTimeout(hubStatusTimer);
    hubStatusTimer = setTimeout(writeStatusNow, 500);
  };
  const heartbeat = setInterval(writeStatusNow, 30_000);
  ctx.subscriptions.push({
    dispose: () => {
      clearInterval(heartbeat);
      clearTimeout(hubStatusTimer);
      handoffWatch?.close();
      if (isHubWindow()) removeHubStatus(scheme, process.pid);
      removeWindowRecord(scheme, process.pid);
    },
  });

  /**
   * Terminal settings that suit Herdr tabs, for this workspace only: in the hub, and in any window you've
   * switched spaces from that is a saved or untitled workspace (they then live in its workspace file, never in
   * a repository's .vscode/settings.json). Set once; a value you chose (here, or in user settings for those
   * marked so) is left alone.
   *  - tabs.description: tabs show just their name; the default adds the cwd folder and can't be set per terminal.
   */
  /** Set `section.key` for this workspace unless it has a value here (or, with `respectUser`, in user settings). */
  function setOnce(section: string, key: string, value: unknown, respectUser: boolean) {
    const conf = vscode.workspace.getConfiguration(section);
    const set = conf.inspect(key);
    if (set?.workspaceValue !== undefined || (respectUser && set?.globalValue !== undefined)) {
      return;
    }
    conf.update(key, value, vscode.ConfigurationTarget.Workspace).then(undefined, logError(`could not set ${section}.${key}`));
  }
  function terminalDefaults() {
    const hub = isHubWindow();
    if (!hub && !(isManagedWindow() && vscode.workspace.workspaceFile)) return;
    setOnce('terminal.integrated', 'tabs.description', HUB_TAB_DESCRIPTION, !hub);
  }
  terminalDefaults();

  // Cockpit window: make "+" create Herdr tabs here: "Herdr Shell" becomes this workspace's default profile.
  // VS Code only applies a workspace default profile in a trusted workspace.
  if (isHubWindow()) {
    setOnce('terminal.integrated', `defaultProfile.${PLATFORM_KEY}`, SHELL_PROFILE_TITLE, false);
    // No Welcome page when the Cockpit window opens (a value you set is left alone).
    setOnce('workbench', 'startupEditor', 'none', true);
    if (!vscode.workspace.isTrusted) log.appendLine('hub workspace is not trusted: VS Code ignores its default terminal profile, so "+" opens local shells');
    // Open the sidebar the first time this Cockpit window opens. Editors with a horizontal activity bar (Cursor) hide
    // extension icons behind an overflow menu, so new users can't find it. Once only: after that, wherever the
    // user put (or closed) the view is left alone.
    if (!ctx.workspaceState.get<boolean>(REVEALED_KEY)) {
      ctx.workspaceState.update(REVEALED_KEY, true);
      vscode.commands.executeCommand('herdr.spaces.focus').then(undefined, (e) => log.appendLine(`could not open the sidebar: ${errorText(e)}`));
    }
  }

  void sync.start().then(() => {
    void maybeAutoStart().catch(logError('auto-start'));
    takeHandoff();
    void maybeOfferHub().catch(logError('hub offer'));
  });

  /**
   * A window just opened without a folder (a new window, or the editor's first launch): offer to make it the
   * hub, so you don't have to find the sidebar or run Set Up Cockpit Window (herdr.offerHubOnStartup).
   */
  async function maybeOfferHub() {
    const hasFolder = !!vscode.workspace.workspaceFolders?.length || !!vscode.workspace.workspaceFile;
    const offer = shouldOfferHub({
      mode: cfg().get<OfferHubSetting>('offerHubOnStartup', 'emptyWindows'),
      isHub: isHubWindow(),
      hasFolder,
      herdrInstalled: binaryFound(binary()),
      hubOpenElsewhere: hubOpen(scheme),
    });
    if (!offer) return;
    const pick = await vscode.window.showInformationMessage(
      'Working with agents? Open Herdr Cockpit here to see your Herdr spaces, agents and shells.',
      'Open Herdr Cockpit',
      'Not Now',
      "Don't Ask Again",
    );
    // An empty window becomes the hub; one with your project keeps it and the hub opens in a new window.
    if (pick === 'Open Herdr Cockpit') await openHub(hasFolder);
    else if (pick === "Don't Ask Again") await cfg().update('offerHubOnStartup', 'never', vscode.ConfigurationTarget.Global);
  }
}

export function deactivate() {}
