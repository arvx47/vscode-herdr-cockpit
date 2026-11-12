// The Herdr commands (Command Palette, sidebar actions, context menus, keybindings) and the pickers they share.
// Moved out of extension.ts's activate(); what they act on comes in through CommandDeps.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { errorText, HerdrClient } from './herdrClient';
import { allPanes, findPane, Model, needingAttention, Pane, Space } from './model';
import type { HerdrSync } from './herdrSync';
import type { ActivityWatcher } from './activity';
import { Placement } from './placement';
import { paneName } from './viewState';
import { isMounted, unmountSpace } from './folders';
import type { AttachTerminals } from './terminals';
import type { TabRestore } from './tabRestore';
import type { Links } from './links';
import { binaryFound, serverStatus } from './connection';
import { HERDR_PROTOCOL } from './herdrTypes';
import { showHelp } from './help';
import { closeInHerdr, ManageDeps, newSpace, newTab, newWorktree, rename, reopenTab, splitPane } from './manage';
import { setUpClaudeUsage } from './usageSetup';
import { DOWN_TEXT, fileReference } from './notices';
import { MANAGED_KEY, PLACE_KEY, THIS_WINDOW_KEY, WindowFlow } from './windowFlow';

/** `herdr plugin install` source of the companion plugin (plugin/ in this repository). */
const PLUGIN_SOURCE = 'sriharirao92/vscode-herdr-cockpit/plugin';
/** Quote for a POSIX shell. */
function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What a command acts on: from the webview, its context menu, or nothing (then ask). */
export type Target = { spaceId?: string; paneId?: string };

export interface CommandDeps {
  ctx: vscode.ExtensionContext;
  log(line: string): void;
  cfg(): vscode.WorkspaceConfiguration;
  model(): Model | undefined;
  sync: HerdrSync;
  client: HerdrClient;
  terms: AttachTerminals;
  tabs: TabRestore;
  flow: WindowFlow;
  links: Links;
  activity: ActivityWatcher;
  manage: ManageDeps;
  isConnected(): boolean;
  kick(): Promise<void>;
  refresh(): Promise<void>;
  ensureConnected(): Promise<boolean>;
  startHerdr(): Promise<boolean>;
  binary(): string;
  herdrEnvNow(): NodeJS.ProcessEnv;
  socketPath(): string;
  render(): void;
  pollUsage(): Promise<void>;
  showShells(): boolean;
  updateWhereSet(key: string, value: unknown): Thenable<void>;
  review(space: Space, pane?: Pane): Promise<unknown>;
  /** This window's own folders (not the Cockpit's, nor the ones we mount). */
  ownFolders(): readonly vscode.WorkspaceFolder[];
  agentIcon(kind?: string): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | undefined;
}

export class Commands {
  constructor(private d: CommandDeps) {}

  private paneOf(t?: Target): { space: Space; pane: Pane } | undefined {
    return findPane(this.d.model(), t?.paneId);
  }

  /** The space a command acts on: the one clicked, else pick one (offering to start Herdr when it's down). */
  async spaceFrom(t?: Target): Promise<Space | undefined> {
    const d = this.d;
    const model = d.model();
    const hit = model?.spaces.find((s) => s.id === t?.spaceId) ?? this.paneOf(t)?.space;
    if (hit) {
      return hit;
    }
    if (!d.isConnected()) {
      if (await d.ensureConnected()) {
        return this.spaceFrom(t);
      }
      return undefined;
    }
    if (!model?.spaces.length) {
      vscode.window.showWarningMessage('Herdr: no spaces yet. Create one with the + next to Spaces.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      model.spaces.map((s) => ({ label: s.label, description: [s.status, s.cwd].filter(Boolean).join(' · '), s })),
      { title: 'Switch to Herdr space' },
    );
    return pick?.s;
  }

  /** Where a "+" terminal goes: the space of the Herdr terminal you're in, the one mounted space, Herdr's focused space, or ask. */
  async targetSpace(): Promise<Space | undefined> {
    const d = this.d;
    if (!d.model()) {
      await d.refresh();
    }
    const model = d.model();
    if (!model) {
      return undefined;
    }
    let id = d.terms.spaceOf(vscode.window.activeTerminal);
    const mounted = model.spaces.filter(isMounted);
    if (!id && mounted.length === 1) {
      id = mounted[0].id;
    }
    id ??= model.focusedSpaceId;
    return model.spaces.find((s) => s.id === id) ?? (await this.spaceFrom());
  }

  /** Pick an agent or shell from every space (only agents with `agentsOnly`). Undefined when cancelled. */
  private async pickPane(title: string, agentsOnly = false): Promise<{ space: Space; pane: Pane } | undefined> {
    const d = this.d;
    if (!d.isConnected() && !(await d.ensureConnected())) {
      return undefined;
    }
    const model = d.model();
    const all = allPanes(model).filter(({ pane }) => pane.isAgent || (!agentsOnly && d.showShells()));
    if (!all.length) {
      let none = 'Herdr: no panes yet.';
      if (agentsOnly) {
        none = 'Herdr: no agents running.';
      }
      vscode.window.showInformationMessage(none);
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
      if (d.terms.has(pane.id)) {
        parts.push('open');
      }
      let iconPath = d.agentIcon(undefined) ?? new vscode.ThemeIcon('terminal');
      if (pane.isAgent) {
        iconPath = d.agentIcon(pane.agentKind) ?? new vscode.ThemeIcon('hubot');
      }
      return { label: paneName(tab, pane), description: parts.join(' · '), iconPath, hit: { space, pane } };
    });
    const pick = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    return pick?.hit;
  }

  /** The agent a command acts on: the one clicked, the agent tab you're in, or pick one. */
  private async agentFrom(t: Target | undefined, title: string): Promise<{ space: Space; pane: Pane } | undefined> {
    const clicked = this.paneOf(t);
    if (clicked?.pane.isAgent) {
      return clicked;
    }
    const here = this.paneOf({ paneId: this.d.terms.paneOf(vscode.window.activeTerminal)?.paneId });
    if (!t && here?.pane.isAgent) {
      return here;
    }
    return this.pickPane(title, true);
  }

  /** Send a prompt to an agent, as if you typed it in its pane and pressed Enter. */
  private async promptAgent(hit: { space: Space; pane: Pane }, text: string) {
    const d = this.d;
    const name = paneName(hit.space.tabs.find((t) => t.id === hit.pane.tabId), hit.pane);
    try {
      await d.manage.actions.promptAgent(hit.pane.id, text);
      vscode.window.setStatusBarMessage(`Herdr: sent to ${name}`, 3000);
      d.log(`prompted ${hit.pane.id} (${text.length} characters)`);
      void d.kick();
    } catch (e) {
      vscode.window.showErrorMessage(`Herdr: couldn't send to ${name}: ${errorText(e)}`);
    }
  }

  /** A space or pane from a sidebar/context-menu target. */
  private itemOf(t?: Target): { space: Space; pane?: Pane } | undefined {
    const pane = this.paneOf(t);
    if (pane) {
      return pane;
    }
    const space = this.d.model()?.spaces.find((s) => s.id === t?.spaceId);
    if (space) {
      return { space };
    }
    return undefined;
  }

  /** Right-click "Open/Attach in its own window" or "Add/Attach in this window": a space opens all its panes, a pane just itself. */
  private async placeIn(t: Target | undefined, place: Placement) {
    const it = this.itemOf(t);
    if (!it) {
      return;
    }
    const placed = await this.d.flow.switchTo(it.space, { pane: it.pane, place, autoAttach: !it.pane });
    if (!placed || !it.pane) {
      return;
    }
    // Placed already: attaching through attachPane would decide where it goes a second time.
    const now = findPane(this.d.model(), it.pane.id);
    if (now) {
      this.d.flow.showPane(now.pane);
    }
  }

  register(): vscode.Disposable[] {
    const d = this.d;
    const spaceFrom = (t?: Target) => this.spaceFrom(t);
    const targetSpace = () => this.targetSpace();
    const paneOf = (t?: Target) => this.paneOf(t);
    const pickPane = (title: string, agentsOnly?: boolean) => this.pickPane(title, agentsOnly);
    const agentFrom = (t: Target | undefined, title: string) => this.agentFrom(t, title);
    const promptAgent = (hit: { space: Space; pane: Pane }, text: string) => this.promptAgent(hit, text);
    const itemOf = (t?: Target) => this.itemOf(t);
    const placeIn = (t: Target | undefined, place: Placement) => this.placeIn(t, place);
    return [
      vscode.commands.registerCommand('herdr.refresh', () => d.kick()),
      vscode.commands.registerCommand('herdr.startServer', () => d.startHerdr()),
      vscode.commands.registerCommand('herdr.openInstallDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://herdr.dev'))),
      vscode.commands.registerCommand('herdr.copyDiagnostics', async () => {
        const st = await serverStatus(d.binary(), d.herdrEnvNow());
        const text = [
          `Herdr Cockpit ${d.ctx.extension.packageJSON.version} · VS Code ${vscode.version} · ${process.platform}`,
          `connection: ${JSON.stringify(d.sync.conn)}`,
          `binary: ${d.binary()} (${binaryFound(d.binary()) ? 'found' : 'NOT FOUND'})`,
          `socket: ${d.socketPath()}${d.cfg().get<string>('socketPath') ? ' (herdr.socketPath)' : ''} (${fs.existsSync(d.socketPath()) ? 'exists' : 'missing'})`,
          `herdr status server: ${st ? JSON.stringify(st) : 'no answer'}`,
          `expected protocol: ${HERDR_PROTOCOL}`,
        ].join('\n');
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Herdr Cockpit: diagnostics copied to the clipboard.');
      }),
      vscode.commands.registerCommand('herdr.connectionMenu', async () => {
        if (d.isConnected()) return vscode.commands.executeCommand('herdr.focusAttention');
        const conn = d.sync.conn;
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
        if (sp) await d.flow.switchTo(sp);
      }),
      // Space cards say Open / Add, pane rows say Attach (a menu label is per command); both run placeIn.
      vscode.commands.registerCommand('herdr.openInOwnWindow', (t?: Target) => placeIn(t, 'window')),
      vscode.commands.registerCommand('herdr.addToWorkspace', async (t?: Target) => {
        if (itemOf(t)) {
          return placeIn(t, 'workspace');
        }
        // From the "This window" card or the Command Palette: pick one of the spaces not open here.
        const others = (d.model()?.spaces ?? []).filter((s) => !d.flow.isOpenHere(s));
        if (!others.length) {
          vscode.window.showInformationMessage('Herdr: every space is already open in this window.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          others.map((s) => ({ label: s.label, description: [s.status, s.cwd].filter(Boolean).join(' · '), s })),
          { title: 'Add a Herdr space to this window' },
        );
        if (pick) {
          await placeIn({ spaceId: pick.s.id }, 'workspace');
        }
      }),
      vscode.commands.registerCommand('herdr.newSpaceHere', async () => {
        // A new space in this window's folder (asking which one when there are several).
        const folders = d.ownFolders();
        if (!folders.length) {
          return newSpace(d.manage);
        }
        let folder: string | undefined = folders[0].uri.fsPath;
        if (folders.length > 1) {
          const pick = await vscode.window.showQuickPick(
            folders.map((f) => ({ label: f.name, description: f.uri.fsPath, path: f.uri.fsPath })),
            { title: 'New space', placeHolder: 'Which folder should the new space live in?' },
          );
          folder = pick?.path;
        }
        if (folder) {
          await newSpace(d.manage, folder);
        }
      }),
      vscode.commands.registerCommand('herdr.attachInSpaceWindow', (t?: Target) => placeIn(t, 'window')),
      vscode.commands.registerCommand('herdr.attachInThisWindow', (t?: Target) => placeIn(t, 'workspace')),
      vscode.commands.registerCommand('herdr.askWhereToOpenSpaces', async () => {
        // Both remembered answers: "Always…" (herdr.windowMode folder) and "Use This Window" (workspace).
        await d.ctx.workspaceState.update(PLACE_KEY, undefined);
        await d.ctx.workspaceState.update(THIS_WINDOW_KEY, undefined);
        vscode.window.setStatusBarMessage('Herdr: this window will ask where to open spaces again', 2500);
      }),
      vscode.commands.registerCommand('herdr.unmountSpace', async (t?: Target) => {
        const sp = await spaceFrom(t);
        if (sp) {
          await unmountSpace(sp);
          d.render();
        }
      }),
      vscode.commands.registerCommand('herdr.attach', async (t?: Target) => {
        const hit = paneOf(t) ?? (await pickPane('Go to a Herdr agent or shell'));
        if (hit) {
          await d.flow.attachPane(hit.space, hit.pane);
        }
      }),
      vscode.commands.registerCommand('herdr.goToPane', async () => {
        const hit = await pickPane('Go to a Herdr agent or shell');
        if (hit) {
          await d.flow.attachPane(hit.space, hit.pane);
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
        const ref = fileReference(editor.document.uri.fsPath, editor.selection, hit.pane.cwd ?? hit.space.cwd);
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
        if (hit) return d.review(hit.space, hit.pane);
        const sp = await spaceFrom(t);
        if (sp) await d.review(sp);
      }),
      vscode.commands.registerCommand('herdr.toggleShellPanes', () => d.updateWhereSet('showShellPanes', !d.showShells())),
      vscode.commands.registerCommand('herdr.openHelp', () => showHelp(d.ctx)),
      vscode.commands.registerCommand('herdr.setKiroCredits', async () => {
        const current = d.cfg().get<number>('kiroMonthlyCredits', 0);
        const v = await vscode.window.showInputBox({
          title: 'Kiro monthly credits',
          prompt: "Your plan's monthly credit allowance (Kiro shows it in /usage). 0 hides the bar.",
          value: current ? String(current) : '',
          validateInput: (s) => (s.trim() === '' || (Number.isFinite(Number(s)) && Number(s) >= 0) ? undefined : 'Enter a number'),
        });
        if (v === undefined) return;
        await d.cfg().update('kiroMonthlyCredits', Number(v) || 0, vscode.ConfigurationTarget.Global);
        d.pollUsage();
      }),
      vscode.commands.registerCommand('herdr.setupClaudeUsage', async () => {
        if (await setUpClaudeUsage(os.homedir(), (m) => d.log(m))) d.pollUsage();
      }),
      vscode.commands.registerCommand('herdr.newSpace', () => newSpace(d.manage)),
      // From a space card (its repo), or the Command Palette / a key (the repo open in this window, else ask).
      vscode.commands.registerCommand('herdr.newWorktree', async (t?: Target) => {
        await newWorktree(d.manage, itemOf(t)?.space);
      }),
      vscode.commands.registerCommand('herdr.newTab', async (t?: Target) => {
        // From the keyboard there's no target: use the space you're working in, like a "+" terminal.
        let sp: Space | undefined;
        if (t) {
          sp = await spaceFrom(t);
        } else {
          sp = await targetSpace();
        }
        if (sp) await newTab(d.manage, sp);
      }),
      // From the Command Palette: they act on the Herdr tab you're in.
      vscode.commands.registerCommand('herdr.terminal.newTab', async () => {
        const sp = await targetSpace();
        if (sp) {
          await newTab(d.manage, sp);
        }
      }),
      vscode.commands.registerCommand('herdr.terminal.splitPane', async () => {
        const hit = paneOf({ paneId: d.terms.paneOf(vscode.window.activeTerminal)?.paneId });
        if (!hit) {
          vscode.window.showInformationMessage('Herdr: click into a Herdr terminal tab first, then split it.');
          return;
        }
        await splitPane(d.manage, hit.space, hit.pane);
      }),
      vscode.commands.registerCommand('herdr.reopenClosedTab', async () => {
        const last = d.tabs.takeClosed();
        if (last === undefined || last === 'editor') {
          await vscode.commands.executeCommand('workbench.action.reopenClosedEditor');
          return;
        }
        d.log(`reopening closed tab ${last.paneId} (${last.closedInHerdr ? 'closed in Herdr' : 'detached'})`);
        await reopenTab(d.manage, last);
      }),
      vscode.commands.registerCommand('herdr.rename', async (t?: Target) => {
        const it = itemOf(t);
        if (it) await rename(d.manage, it);
      }),
      vscode.commands.registerCommand('herdr.closeInHerdr', async (t?: Target) => {
        const it = itemOf(t);
        if (it) await closeInHerdr(d.manage, it);
      }),
      vscode.commands.registerCommand('herdr.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${d.ctx.extension.id}`),
      ),
      vscode.commands.registerCommand('herdr.showRaw', async (t?: Target) => {
        const hit = paneOf(t) ?? (t ? undefined : await pickPane('Show the raw Herdr record of'));
        const raw = hit ? { pane: hit.pane.raw.pane, agent: hit.pane.raw.agent, activity: d.activity.get(hit.pane.id) } : d.model()?.spaces.find((s) => s.id === t?.spaceId)?.raw;
        if (!raw) return;
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(raw, null, 2) });
        vscode.window.showTextDocument(doc);
      }),
      vscode.commands.registerCommand('herdr.focusAttention', async () => {
        if (!d.model()) {
          return d.refresh();
        }
        // Blocked agents first, then done ones; again from one of them goes to the next, and around.
        const waiting = needingAttention(d.model());
        if (!waiting.length) {
          vscode.window.showInformationMessage('Herdr: no agent needs attention right now.');
          return;
        }
        const current = d.terms.paneOf(vscode.window.activeTerminal)?.paneId;
        const i = waiting.findIndex((x) => x.pane.id === current);
        const next = waiting[(i + 1) % waiting.length];
        await d.flow.attachPane(next.space, next.pane);
      }),
      vscode.commands.registerCommand('herdr.openTui', () => {
        const t = vscode.window.createTerminal({
          name: 'herdr',
          shellPath: d.binary(),
          iconPath: new vscode.ThemeIcon('layout-sidebar-left'),
          location: { viewColumn: vscode.ViewColumn.Active },
        });
        t.show();
        setTimeout(() => d.kick(), 1500);
      }),
      vscode.commands.registerCommand('herdr.toggleFollow', async () => {
        const on = !d.cfg().get<boolean>('followMode', false);
        await d.updateWhereSet('followMode', on);
        // Follow mode acts in windows you switched spaces from; turned off here, this window stops being one.
        await d.ctx.workspaceState.update(MANAGED_KEY, on || undefined);
        vscode.window.setStatusBarMessage(`Herdr follow mode ${on ? 'on' : 'off'}`, 2500);
        d.render();
      }),
      vscode.commands.registerCommand('herdr.setupHub', async () => {
        await d.links.openHub();
      }),
      vscode.commands.registerCommand('herdr.installPlugin', () => {
        // Herdr previews what the plugin runs and asks before installing; the user confirms in this terminal.
        const t = vscode.window.createTerminal({ name: 'Install Herdr plugin', iconPath: new vscode.ThemeIcon('extensions') });
        t.show();
        t.sendText(`${shellQuote(d.binary())} plugin install ${PLUGIN_SOURCE}`, true);
      }),
      vscode.commands.registerCommand('herdr.dumpSnapshot', async () => {
        try {
          const raw = await d.client.request('session.snapshot');
          const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(raw, null, 2) });
          vscode.window.showTextDocument(doc);
        } catch (e) {
          vscode.window.showErrorMessage(`Herdr: ${errorText(e)}`);
        }
      }),
    ];
  }
}
