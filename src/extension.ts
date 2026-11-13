import * as vscode from 'vscode';
import { EXTENSION_NAME, MESSAGE_PREFIX } from './brand';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorText, expandHome, HerdrClient, resolveSocketPath } from './herdrClient';
import { sleep } from './format';
import { allPanes, AgentStatus, countByStatus, findPane, Model, Pane, Space } from './model';
import type { PaneProcessInfoResult } from './herdrTypes';
import { HerdrPanel, PanelAction } from './panel';
import { HerdrSync } from './herdrSync';
import { ActivityTarget, ActivityWatcher, describeProcess, isShellProcess, leaderProcess } from './activity';
import { AgentNames, buildViewState, paneName, setAgentNames, setProfileNames, TAB_PREFIX, tabName, ViewConnection } from './viewState';
import { AgentProfile, readAgentList, startingTable } from './agentProfiles';
import { agentLogo } from './agentLogos';
import { gitInfo, mainBranch } from './gitInfo';
import { isMounted, PREFIX } from './folders';
import { AttachTerminals, TerminalLocationSetting } from './terminals';
import { TabAction } from './builtinTerminal';
import { findFileRefs } from './termLinks';
import { binaryFound, diagnose, herdrEnv, resolveBinary, startServer } from './connection';
import { claimant, hubDir, hubOpen, hubWorkspaceFile, legacyHubWorkspaceFile, OfferHubSetting, readClaim, removeClaim, windowKey, writeClaim, shouldOfferHub, normPath } from './hubFiles';
import { HERDR_PROTOCOL } from './herdrTypes';
import { reviewChanges } from './review';
import { TabRestore } from './tabRestore';
import { HUB_TAB_DESCRIPTION, Links, PLATFORM_KEY } from './links';
import { CockpitFiles } from './cockpitFiles';
import { DOWN_TEXT } from './notices';
import { Notifications } from './notifications';
import { MANAGED_KEY, WindowFlow } from './windowFlow';
import { Commands, Target } from './commands';
import { agentSlug, HerdrActions } from './herdrActions';
import { closedTab, ManageDeps } from './manage';
import { registerProfiles, SHELL_PROFILE_TITLE } from './profiles';
import { ClaudeAccount, codexBinary, codexLiveUsage, ProviderUsage, readUsage } from './usage';

const REVEALED_KEY = 'herdr.hubViewRevealed';
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
  newSpaceHere: 'herdr.newSpaceHere',
  newWorktree: 'herdr.newWorktree',
  addSpaceHere: 'herdr.addToWorkspace',
  openTui: 'herdr.openTui',
  refresh: 'herdr.refresh',
  setupHub: 'herdr.setupHub',
  startServer: 'herdr.startServer',
  copyDiagnostics: 'herdr.copyDiagnostics',
  openInstallDocs: 'herdr.openInstallDocs',
};

export function activate(ctx: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration('herdr');
  const log = vscode.window.createOutputChannel(EXTENSION_NAME);
  // The integration test (src/test/vscode) reads the log from the console.
  if (process.env.HERDR_HUB_TEST_SESSION) {
    const append = log.appendLine.bind(log);
    log.appendLine = (line: string) => (console.log(`[herdr-cockpit log] ${line}`), append(line));
  }
  /** A .catch() handler that logs instead of leaving an unhandled rejection. */
  const logError = (what: string) => (e: unknown) => log.appendLine(`${what}: ${errorText(e)}`);
  const client = new HerdrClient(() => resolveSocketPath(cfg().get<string>('socketPath')));
  // When did each agent enter its current state? (observed locally; Herdr exposes only a sequence number)
  const stateSince = new Map<string, { status?: AgentStatus; at: number }>();
  const showShells = () => cfg().get<boolean>('showShellPanes', true);
  /**
   * Change a setting where its current value comes from: a toggle written to the user settings does nothing
   * while the workspace sets the value.
   */
  const updateWhereSet = (key: string, value: unknown) => {
    let target = vscode.ConfigurationTarget.Global;
    if (cfg().inspect(key)?.workspaceValue !== undefined) {
      target = vscode.ConfigurationTarget.Workspace;
    }
    return cfg().update(key, value, target);
  };
  /** The sidebar lists only the spaces open in this window. */
  const panel = new HerdrPanel(ctx.extensionUri, (a: PanelAction) => {
    const id = PANEL_COMMANDS[a.command];
    if (id) vscode.commands.executeCommand(id, { spaceId: a.spaceId, paneId: a.paneId, account: a.account } satisfies Target);
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
      tabs.save();
    },
    {
      binary: () => binary(),
      env: () => herdrEnvNow(),
      log: (line) => log.appendLine(line),
      // Herdr doesn't say who took a pane over: windows record the panes they take (hubFiles.ts, claims).
      claim: (paneId) => writeClaim(socketPath(), paneId, { editor: vscode.env.appName, scheme: vscode.env.uriScheme, pid: process.pid, at: Date.now(), window: thisWindow }),
      unclaim: (paneId) => removeClaim(socketPath(), paneId, process.pid),
      holder: (paneId, since) => claimant(readClaim(socketPath(), paneId), { scheme: vscode.env.uriScheme, pid: process.pid, window: thisWindow }, since),
      onTakenOver: (paneId, who, expected) => {
        if (!expected) {
          notifications.tookOver(paneId, who);
        }
      },
      request: (method, params, timeoutMs) => client.request(method, params, timeoutMs),
      copyOnSelect: () => cfg().get<boolean>('copyOnSelect', false),
    },
    (paneId) => void closedTabByUser(paneId).catch(logError('close in Herdr')),
    (paneId, name) => void renamedTabByUser(paneId, name).catch(logError('rename in Herdr')),
  );
  const tabs = new TabRestore({
    state: ctx.workspaceState,
    terms,
    model: () => model,
    enabled: () => cfg().get<boolean>('restoreTabs', true),
    log: (line) => log.appendLine(line),
  });
  const flow: WindowFlow = new WindowFlow({
    state: ctx.workspaceState,
    log: (line) => log.appendLine(line),
    model: () => model,
    terms,
    client,
    socketPath: () => socketPath(),
    isHubWindow: () => isHubWindow(),
    openHub: (): Promise<void> => links.openHub(),
    mounted() {
      terminalDefaults();
      render();
    },
    focused(spaceId) {
      lastFocusedSpace = spaceId; // don't let follow-mode bounce us
    },
  });
  const notifications = new Notifications({
    model: () => model,
    conn: () => sync.conn,
    socketPath: () => socketPath(),
    terms,
    isOpenHere: (space) => flow.isOpenHere(space),
    attachPane: (space, pane) => flow.attachPane(space, pane),
    review: (space, pane) => review(space, pane),
    startHerdr: () => startHerdr(),
    kick: () => kick(),
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'herdr.focusAttention';
  status.show();

  let model: Model | undefined;
  /** Each pane's name at the last snapshot, to notice renames made in Herdr. */
  const paneNames = new Map<string, string>();
  setAgentNames(cfg().get<AgentNames>('agentNames', 'title'));
  /** The agents' plan usage the sidebar shows (pollUsage). */
  let usage: ProviderUsage[] = [];
  /** Set further down: write the Cockpit window's status file for the Herdr plugin (debounced). */
  let scheduleHubStatus = () => {};
  let lastStatus = new Map<string, AgentStatus | undefined>();
  let lastFocusedSpace: string | undefined;
  let firstLoad = true;

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
  /** One per Herdr socket, shared by every editor window: only one of them starts that session's server. */
  const startLockFile = () => path.join(hubDir(), 'locks', `start-${crypto.createHash('sha256').update(socketPath()).digest('hex').slice(0, 24)}.lock`);
  /** The space whose tabs were open when Herdr went away, to offer reopening them. */
  let lostSpace: { id: string; label: string } | undefined;
  const sync = new HerdrSync({
    client,
    socketPath,
    diagnose: (e) => diagnose(binary(), socketPath(), !!cfg().get<string>('socketPath'), herdrEnvNow(), e),
    onSnapshot: (next) => apply(next),
    onConnected() {
      notifications.connected();
      tabs.restore();
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
      if (afterLoss) {
        void notifications.lost().catch(logError('lost Herdr'));
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

  /**
   * You closed a Herdr tab yourself: close the pane in Herdr too (herdr.closeTabInHerdr). Asks first for an
   * agent, a shell running something, or the last tab of a space (Herdr then closes the whole space).
   */
  async function closedTabByUser(paneId: string) {
    const mode = cfg().get<'ask' | 'always' | 'never'>('closeTabInHerdr', 'never');
    const hit = paneOf({ paneId });
    if (!hit) {
      return;
    }
    const closed = closedTab(hit.space, hit.pane);
    tabs.remember(closed);
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

  /** You renamed a Herdr tab: rename the shell's pane, or the agent, in Herdr to match. */
  async function renamedTabByUser(paneId: string, name: string) {
    const hit = paneOf({ paneId });
    let label = name.trim();
    // The tab shows "Herdr: <name>"; Herdr gets only the name.
    if (label.toLowerCase().startsWith(TAB_PREFIX.toLowerCase())) {
      label = label.slice(TAB_PREFIX.length).trim();
    }
    if (!hit || !label || !isConnected()) return;
    if (hit.pane.isAgent) {
      // Herdr agent names are identifiers (they're also CLI targets).
      const slug = agentSlug(label);
      if (!slug) return void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: agent names use lowercase letters, digits, - and _; "${label}" stays a VS Code tab name only.`);
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
    if (sp) await flow.switchTo(sp);
    else vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: "${lost.label}" isn't in Herdr anymore.`);
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
    let r: Awaited<ReturnType<typeof startServer>>;
    try {
      r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Herdr…' }, () =>
        startServer(bin, herdrEnvNow(), logFile, undefined, startLockFile()),
      );
    } catch (e) {
      r = { ok: false, error: errorText(e) };
    } finally {
      sync.endStarting(prev);
    }
    if (!r.ok) {
      log.appendLine(`start herdr failed: ${r.error}`);
      const pick = await vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: couldn't start the server. ${r.error ?? ''}`, 'Show Log');
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
      `Herdr isn't running. Start it in the background whenever the ${EXTENSION_NAME} window opens?`,
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
    flow.noteFolders(model);
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
        here: (sp) => flow.isOpenHere(sp),
        needsYou: cfg().get<boolean>('showNeedsYou', false),
        thisWindow: thisWindowView(),
      }),
    );
  }
  /** This window's own folders: not the Cockpit's ~/.herdr-cockpit, nor the "⬢ <space>" folders we mount. */
  const ownFolders = () =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => !f.name.startsWith(PREFIX) && normPath(f.uri.fsPath) !== normPath(hubDir()));
  /** For the sidebar's "This window": only a window with folders of its own (not the Cockpit window). */
  function thisWindowView(): { name: string } | undefined {
    const folders = ownFolders();
    if (isHubWindow() || !folders.length) {
      return undefined;
    }
    if (folders.length === 1) {
      return { name: folders[0].name };
    }
    return { name: `this window's ${folders.length} folders` };
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

  // Agents' plan usage from their local files: once a minute, only while the sidebar is visible (`usage` is
  // declared further up, with the rest of what render() reads).
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
    const opts = { codexLive: codexLive.data, only, kiroMonthlyCredits: cfg().get<number>('kiroMonthlyCredits', 0), claudeAccounts: claudeAccounts() };
    const next = await readUsage(os.homedir(), Date.now(), opts).catch((e) => {
      log.appendLine(`usage: ${errorText(e)}`);
      return usage;
    });
    if (JSON.stringify(next) !== JSON.stringify(usage)) {
      usage = next;
      scheduleRender();
    }
    // Once Claude's plan limits are captured, the Usage section drops its Set up plan limits… button: the view's ⋯
    // menu offers it instead (to check or repair the setup, e.g. after another app rewrote the status line).
    // Unchanged while no Claude agent runs (its usage isn't read then).
    const claude = next.find((u) => u.id === 'claude');
    if (claude) {
      void vscode.commands.executeCommand('setContext', 'herdr.claudeLimitsOn', !claude.canSetUpLimits);
    }
  }
  const usageTimer = setInterval(pollUsage, 60_000);

  // Keep git branch/changes fresh even without Herdr events (gitInfo re-renders when they change). Only while the
  // sidebar shows: it's drawn again when it becomes visible.
  const redrawTimer = setInterval(() => {
    if (model && panel.visible) {
      render();
    }
  }, 15000);

  // ---------- applying a new snapshot ----------
  /** Renamed in Herdr (TUI, CLI, sidebar), a new terminal title or herdr.agentNames: rename its tab here too, without focusing it. */
  function syncNames(m: Model) {
    const seen = new Set<string>();
    for (const sp of m.spaces)
      for (const tab of sp.tabs)
        for (const p of tab.panes) {
          const n = tabName(tab, p);
          const was = paneNames.get(p.id);
          if (was !== undefined && was !== n && terms.has(p.id)) terms.rename(p.id, n);
          paneNames.set(p.id, n);
          seen.add(p.id);
        }
    for (const id of [...paneNames.keys()]) {
      if (!seen.has(id)) {
        paneNames.delete(id);
      }
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
          void notifications.agentChanged(sp, a).catch(logError('notify'));
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
      !flow.switching &&
      cfg().get<boolean>('followMode', false) &&
      isManagedWindow()
    ) {
      const sp = next.spaces.find((s) => s.id === focused);
      if (sp) {
        log.appendLine(`follow: herdr focused ${sp.label}`);
        void flow.switchTo(sp, { fromHerdr: true }).catch(logError('follow'));
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
    status.tooltip = `${MESSAGE_PREFIX}: ${agents.length} agents, ${working} working, ${blocked} blocked, ${done} done.\nClick to jump to the one that needs you.`;
    status.command = 'herdr.focusAttention';
    panel.badge = blocked + done ? { value: blocked + done, tooltip: `${blocked} blocked, ${done} done` } : undefined;
  }

  // ---------- actions ----------
  /** Review an agent's (or a space's) changes; on a worktree space, the whole branch. */
  function review(space: Space, pane?: Pane) {
    return reviewChanges(pane?.cwd ?? space.cwd, pane?.label ?? space.label, { worktree: !!space.worktree?.is_linked_worktree });
  }

  const paneOf = (t?: Target): { space: Space; pane: Pane } | undefined => findPane(model, t?.paneId);
  // ---------- create / rename / close ----------
  /** Herdr's agent manifests, asked once per connection (they change only with a Herdr update). */
  /** The starting list was written into the user settings (startingTable()): from then on the table is the list. */
  const AGENT_LIST_SAVED_KEY = 'herdr.agentListSaved';
  /**
   * The list to write into the user settings, when it's due: the first time (with what older versions saved moved
   * in), or after you reset the setting. Undefined when the user settings already hold the list.
   */
  function startingAgentTable(): Record<string, string> | undefined {
    const agents = cfg().inspect<unknown>('agents')?.globalValue;
    const oldProfiles = cfg().inspect<unknown>('agentProfiles')?.globalValue;
    const saved = ctx.globalState.get<boolean>(AGENT_LIST_SAVED_KEY, false);
    if (saved && agents && typeof agents === 'object' && !Array.isArray(agents) && oldProfiles === undefined) {
      return undefined;
    }
    return startingTable(agents, oldProfiles);
  }
  /** Write the starting list (startingAgentTable()) into the user settings, so the Settings page shows every row as yours. */
  async function saveStartingAgents(table: Record<string, string>) {
    await cfg().update('agents', table, vscode.ConfigurationTarget.Global);
    if (cfg().inspect<unknown>('agentProfiles')?.globalValue !== undefined) {
      await cfg().update('agentProfiles', undefined, vscode.ConfigurationTarget.Global);
    }
    await ctx.globalState.update(AGENT_LIST_SAVED_KEY, true);
    log.appendLine(`agents: the list is in your user settings now (${Object.keys(table).join(', ')})`);
  }
  /** herdr.agents (the agent list's rows), read when it changes (problems logged once each time). */
  let profiles: AgentProfile[] | undefined;
  function agentProfiles(): AgentProfile[] {
    if (!profiles) {
      const read = readAgentList(startingAgentTable() ?? cfg().inspect<unknown>('agents')?.globalValue, os.homedir());
      for (const problem of read.problems) {
        log.appendLine(problem);
      }
      setProfileNames(read.profiles.filter((p) => !p.plain));
      profiles = read.profiles;
    }
    return profiles;
  }
  agentProfiles();
  /**
   * The Claude Code accounts with a usage card: the default one (~/.claude, named after its first row without
   * CLAUDE_CONFIG_DIR), then one per other CLAUDE_CONFIG_DIR in the list (named after its first row).
   */
  function claudeAccounts(): ClaudeAccount[] {
    const home = os.homedir();
    const claude = agentProfiles().filter((p) => p.kind === 'claude');
    const defaultDir = path.join(home, '.claude');
    const named = claude.find((p) => !p.env.CLAUDE_CONFIG_DIR || path.resolve(p.env.CLAUDE_CONFIG_DIR) === defaultDir);
    const accounts: ClaudeAccount[] = [{ configDir: defaultDir, name: named?.name ?? 'Claude Code' }];
    for (const p of claude) {
      const dir = p.env.CLAUDE_CONFIG_DIR;
      if (dir && !accounts.some((a) => a.configDir === path.resolve(dir))) {
        accounts.push({ configDir: path.resolve(dir), name: p.name });
      }
    }
    return accounts;
  }
  const starting = startingAgentTable();
  if (starting) {
    void saveStartingAgents(starting).catch(logError('agents'));
  }
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
    attach: (space, pane, startingAs) => flow.attachPane(space, pane, startingAs),
    agentIcon,
    spaces: () => model?.spaces ?? [],
    branchOf: (cwd) => {
      const g = git(cwd);
      return g && !g.detached ? g.branch : undefined;
    },
    // git reads the repo's own config: only in a trusted window (see gitInfo.ts).
    mainBranch: async (cwd) => {
      if (!vscode.workspace.isTrusted) {
        return undefined;
      }
      return mainBranch(cwd);
    },
    isOpenHere: (space) => flow.isOpenHere(space),
    agentNames: () => model?.spaces.flatMap((s) => s.agents.map((a) => a.raw.agent?.name).filter((n): n is string => !!n)) ?? [],
    herdrAgentKinds: () => herdrAgentKinds(),
    agentProfiles: () => agentProfiles(),
    renameTerminal: async (paneId, name) => terms.rename(paneId, name),
    ensureConnected: () => ensureConnected(),
    log: (m) => log.appendLine(m),
  };
  const links: Links = new Links({
    log: (line) => log.appendLine(line),
    isHubWindow,
    myFolders: () => flow.myFolders(),
    socketPath,
    model: () => model,
    isConnected,
    kick,
    ensureConnected,
    review,
    async showSpace(sp) {
      await ctx.workspaceState.update(MANAGED_KEY, true);
      if (terms.spaces()[0] !== sp.id || !isMounted(sp)) {
        await flow.switchTo(sp);
      }
    },
    attachPane: (sp, pane) => flow.attachPane(sp, pane),
  });

  const commands = new Commands({
    ctx,
    log: (line) => log.appendLine(line),
    cfg,
    model: () => model,
    sync,
    client,
    terms,
    tabs,
    flow,
    links,
    activity,
    manage,
    isConnected,
    kick,
    refresh,
    ensureConnected,
    startHerdr,
    binary,
    herdrEnvNow,
    socketPath,
    render,
    pollUsage,
    showShells,
    updateWhereSet,
    review,
    ownFolders,
    agentIcon,
    claudeAccounts: () => claudeAccounts(),
  });

  ctx.subscriptions.push(
    registerProfiles({
      ...manage,
      targetSpace: () => commands.targetSpace(),
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
    tabs,
    notifications,
    {
      dispose: () => {
        sync.dispose();
        clearTimeout(renderTimer);
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
      if (e.affectsConfiguration('herdr.agents') || e.affectsConfiguration('herdr.agentProfiles')) {
        // Reset in the Settings page: write the starting list again, so its rows are back as yours.
        const again = startingAgentTable();
        if (again) {
          void saveStartingAgents(again).catch(logError('agents'));
        }
        profiles = undefined;
        agentProfiles();
        if (model) {
          syncNames(model);
        }
        pollUsage(); // the Claude Code accounts may have changed
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

    ...commands.register(),
  );

  // ---------- Cockpit window, deep links, files for the Herdr plugin (hubFiles.ts) ----------
  const scheme = vscode.env.uriScheme;
  const extensionVersion: string = ctx.extension.packageJSON.version;


  // ---------- the built-in tabs' own commands: find, scrolling the history, output, file links ----------

  /** `herdr.terminalActive`: the focused terminal is a Herdr tab (its keybindings apply). */
  /**
   * "done" stays in Herdr until it sees you look at the agent: focusing it there (or clicking it in the sidebar,
   * which sends agent.focus) makes it idle. Going to its tab yourself (tab bar, keyboard) does the same.
   */
  function markSeen(term: vscode.Terminal | undefined) {
    const hit = paneOf({ paneId: terms.paneOf(term)?.paneId });
    if (!hit?.pane.isAgent || hit.pane.status !== 'done' || !vscode.window.state.focused || !isConnected()) {
      return;
    }
    client
      .request('agent.focus', { target: hit.pane.id })
      .then(() => kick())
      .catch(logError('agent.focus'));
  }
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
    vscode.window.onDidChangeActiveTerminal((t) => markSeen(t)),
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
        // Every candidate at once (a hovered line can hold dozens); the first existing file per reference wins.
        const found = await Promise.all(
          findFileRefs(context.line)
            .slice(0, 50)
            .map(async (ref): Promise<FileLink | undefined> => {
              const p = expandHome(ref.path);
              let candidates = bases.map((base) => path.resolve(base, p));
              if (path.isAbsolute(p)) {
                candidates = [p];
              }
              const isFile = await Promise.all(candidates.map((file) => fs.promises.stat(file).then((st) => st.isFile(), () => false)));
              const file = candidates[isFile.indexOf(true)];
              if (!file) {
                return undefined;
              }
              let tooltip = `Open ${ref.path}`;
              if (ref.line) {
                tooltip += ` at line ${ref.line}`;
              }
              return { startIndex: ref.start, length: ref.length, tooltip, uri: vscode.Uri.file(file), line: ref.line, col: ref.col };
            }),
        );
        return found.filter((l): l is FileLink => !!l);
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
    vscode.window.registerUriHandler({ handleUri: (uri) => void links.handle(uri).catch(logError('link failed')) }),
    links,
  );

  links.watchHandoffs();
  const files = new CockpitFiles({
    extensionId: ctx.extension.id,
    extensionVersion,
    log: (line) => log.appendLine(line),
    isHubWindow,
    myFolders: () => flow.myFolders(),
    isOpenHere: (space) => flow.isOpenHere(space),
    socketPath,
    session: () => links.currentSession(),
    model: () => model,
    conn: () => sync.conn,
    tabs: () => ({ space: terms.spaces()[0], count: terms.count() }),
  });
  scheduleHubStatus = () => files.schedule();
  ctx.subscriptions.push(files);

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
    links.takeHandoff();
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
    const OPEN_HERE = `Open ${EXTENSION_NAME}`;
    const pick = await vscode.window.showInformationMessage(
      `Working with agents? Open ${EXTENSION_NAME} here to see your Herdr spaces, agents and shells.`,
      OPEN_HERE,
      'Not Now',
      "Don't Ask Again",
    );
    // An empty window becomes the hub; one with your project keeps it and the hub opens in a new window.
    if (pick === OPEN_HERE) await links.openHub(hasFolder);
    else if (pick === "Don't Ask Again") await cfg().update('offerHubOnStartup', 'never', vscode.ConfigurationTarget.Global);
  }
}

export function deactivate() {}
