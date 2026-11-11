// Each Herdr agent or shell pane becomes a terminal tab the extension draws itself from Herdr's stream
// (builtinTerminal.ts): drag to select and copy like the Herdr TUI, wheel to scroll Herdr's scrollback.
// Closing the tab only detaches; the process keeps running in Herdr.
import * as vscode from 'vscode';
import type { Pane } from './model';
import { BuiltinDeps, HerdrPty, PtyOptions } from './builtinTerminal';

export { resolveBinary } from './connection';

interface Entry {
  term: vscode.Terminal;
  spaceId: string;
  /** The stream can end (Herdr stopped, pane closed) while the tab stays open with a note. */
  pty?: HerdrPty;
  /** Editor group the tab was opened in. */
  column?: vscode.ViewColumn;
  /** The name we gave the tab (or accepted from a rename). */
  name?: string;
  /** terminal.name when last polled: renames only show up there (VS Code has no rename event). */
  seen?: string;
}

/** The tab still shows the pane: open, and its stream hasn't ended. */
const live = (e: Entry) => e.term.exitStatus === undefined && !e.pty?.ended;

/** herdr.terminalLocation */
export type TerminalLocationSetting = 'editor' | 'editorSplit' | 'panel';

/** How a pane's terminal tab looks: same name as its row in the sidebar, agent logo as the icon. */
export interface TerminalLook {
  name: string;
  iconPath: vscode.TerminalOptions['iconPath'];
}

export class AttachTerminals implements vscode.Disposable {
  private byPane = new Map<string, Entry>();
  private sub: vscode.Disposable;
  /** The editor group Herdr tabs were last opened in, to keep them together across switches. */
  private lastColumn?: vscode.ViewColumn;
  private namePoll: NodeJS.Timeout;
  /** The window is closing: its tabs are going away with it, not because you closed them. */
  shuttingDown = false;

  constructor(
    private location: () => TerminalLocationSetting,
    /** startingAs: agent kind being started in a pane that is still a plain shell. */
    private look: (pane: Pane, startingAs?: string) => TerminalLook,
    /** Called whenever the set of attached panes changes. */
    private onChange: () => void,
    private deps: Omit<BuiltinDeps, 'onEnded'>,
    /**
     * You closed a live tab yourself (its X, Kill Terminal): exit reason User. Tabs we dispose (space switch,
     * pane gone) report Extension, and a closing window Shutdown, so those only ever detach.
     */
    private onUserClose: (paneId: string) => void = () => {},
    /** You renamed a tab (its Rename... menu): VS Code updates terminal.name but fires no event, so poll. */
    private onUserRename: (paneId: string, name: string) => void = () => {},
  ) {
    this.namePoll = setInterval(() => this.pollNames(), 1000);
    this.sub = vscode.window.onDidCloseTerminal((t) => {
      for (const [k, e] of this.byPane)
        if (e.term === t) {
          if (t.exitStatus?.reason === vscode.TerminalExitReason.Shutdown) {
            this.shuttingDown = true;
          }
          const wasLive = !e.pty?.ended;
          this.byPane.delete(k);
          this.onChange();
          if (wasLive && t.exitStatus?.reason === vscode.TerminalExitReason.User) this.onUserClose(k);
        }
    });
  }

  /** A tab for a pane, drawn from Herdr's stream: the pane id, or how to create the pane once the tab opens. */
  newPty(target: string | (() => Promise<string>), opts?: PtyOptions): HerdrPty {
    return new HerdrPty(target, { ...this.deps, onEnded: () => this.onChange() }, opts);
  }

  /** Take control back of tabs that show their pane read-only (another client has it); all of them by default. */
  takeBack(paneIds?: readonly string[]) {
    for (const [paneId, e] of this.byPane) if (!paneIds || paneIds.includes(paneId)) e.pty?.takeBack();
  }

  /** The tab's name, e.g. for a notification. */
  nameOf(paneId: string): string | undefined {
    return this.byPane.get(paneId)?.name;
  }

  /** The live built-in tab behind a terminal, if it's one of ours. */
  ptyOf(term: vscode.Terminal | undefined): HerdrPty | undefined {
    for (const e of this.byPane.values()) if (e.term === term && live(e)) return e.pty;
  }

  /** The pane (and space) a tab shows, if it's one of ours. */
  paneOf(term: vscode.Terminal | undefined): { paneId: string; spaceId: string } | undefined {
    for (const [paneId, e] of this.byPane) if (e.term === term && live(e)) return { paneId, spaceId: e.spaceId };
  }

  /**
   * A changed terminal.name we didn't set is a rename by you. Our own renames (setName) arrive in
   * terminal.name a moment later and match `name`, so they're not echoed back.
   */
  private pollNames() {
    for (const [paneId, e] of this.byPane) {
      if (!live(e)) continue;
      const cur = e.term.name;
      if (cur === e.seen) continue;
      e.seen = cur;
      if (cur === e.name) continue;
      e.name = cur;
      this.onUserRename(paneId, cur);
    }
  }

  /** A live tab is open for this pane (one whose stream ended, e.g. Herdr stopped, doesn't count). */
  has(paneId: string) {
    const e = this.byPane.get(paneId);
    return !!e && live(e);
  }

  /** Live tabs. */
  count(): number {
    return [...this.byPane.values()].filter(live).length;
  }

  /** Spaces that have tabs open (live or not), e.g. to reopen them after Herdr restarts. */
  spaces(): string[] {
    return [...new Set([...this.byPane.values()].map((e) => e.spaceId))];
  }

  /**
   * Panes with a tab open (live or not), e.g. to reopen them with the window: editor-area tabs in the order they
   * sit in the tab bar (so drags count), then the rest (panel tabs, tabs not drawn yet) in the order they opened.
   */
  panes(): { paneId: string; spaceId: string }[] {
    const placed = this.placedTabs().map((t) => t.paneId);
    const rest = [...this.byPane.keys()].filter((id) => !placed.includes(id));
    return [...placed, ...rest].map((paneId) => ({ paneId, spaceId: this.byPane.get(paneId)!.spaceId }));
  }

  /**
   * Our editor-area tabs as the tab bar shows them, group by group. The tab API doesn't say which terminal a tab
   * is, so tabs are matched by name; tabs with the same name are matched in the order they opened.
   */
  private placedTabs(): { paneId: string; tab: vscode.Tab; column: vscode.ViewColumn; index: number }[] {
    const unmatched = [...this.byPane].filter(([, e]) => live(e));
    const placed: { paneId: string; tab: vscode.Tab; column: vscode.ViewColumn; index: number }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      group.tabs.forEach((tab, index) => {
        if (!(tab.input instanceof vscode.TabInputTerminal)) {
          return;
        }
        const i = unmatched.findIndex(([, e]) => e.term.name === tab.label);
        if (i >= 0) {
          placed.push({ paneId: unmatched[i][0], tab, column: group.viewColumn, index });
          unmatched.splice(i, 1);
        }
      });
    }
    return placed;
  }

  /**
   * Put our tabs back in `order` (pane ids), within each editor group, in the slots they already take, e.g. after
   * reopening them with the window: tabs VS Code failed to draw are opened again last. Moving a tab means
   * activating it, so the tab that was active before is shown again at the end.
   */
  async arrange(order: readonly string[]) {
    const rank = new Map(order.map((paneId, i) => [paneId, i] as const));
    const rankOf = (paneId: string) => rank.get(paneId) ?? order.length;
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    const beforePane = this.placedTabs().find((t) => t.tab === before)?.paneId;
    let moved = false;
    for (const column of new Set(this.placedTabs().map((t) => t.column))) {
      // One move at a time, read again from the tab bar after each; never more moves than tabs.
      for (let attempt = 0; attempt < this.byPane.size; attempt++) {
        const here = this.placedTabs().filter((t) => t.column === column);
        const slots = here.map((t) => t.index);
        const wanted = [...here].sort((a, b) => rankOf(a.paneId) - rankOf(b.paneId));
        const k = wanted.findIndex((t, i) => t.index !== slots[i]);
        if (k < 0) {
          break;
        }
        this.byPane.get(wanted[k].paneId)?.term.show(false);
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: slots[k] + 1 });
        moved = true;
      }
    }
    if (!moved) {
      return;
    }
    if (beforePane) {
      this.byPane.get(beforePane)?.term.show(false);
    } else if (before?.input instanceof vscode.TabInputText) {
      await vscode.window.showTextDocument(before.input.uri, { viewColumn: before.group.viewColumn });
    }
  }

  /** The pane has a tab VS Code never opened (it failed to draw it). */
  undrawn(paneId: string): boolean {
    const pty = this.byPane.get(paneId)?.pty;
    return !!pty && !pty.opened;
  }

  /** Close the pane's tab and open a new one, keeping its place in the opening order. */
  replace(pane: Pane, opts: { preserveFocus?: boolean; polite?: boolean } = {}): vscode.Terminal | undefined {
    const order = [...this.byPane.keys()];
    const e = this.byPane.get(pane.id);
    if (e) {
      this.byPane.delete(pane.id);
      e.term.dispose();
    }
    const term = this.attach(pane, opts);
    const at = (paneId: string) => {
      const i = order.indexOf(paneId);
      if (i < 0) {
        return order.length;
      }
      return i;
    };
    this.byPane = new Map([...this.byPane].sort(([a], [b]) => at(a) - at(b)));
    return term;
  }

  /** Some tab lost its pane (Herdr stopped under it). */
  hasExited(): boolean {
    return [...this.byPane.values()].some((e) => !live(e));
  }

  /** Close tabs that lost their pane. */
  disposeExited() {
    this.closeWhere((e) => !live(e));
  }

  /**
   * The editor group for a new tab. Herdr tabs stay together: in the group that already shows them, else the
   * one they were in last (if it still exists), else the active group. Opening into "the active group" each
   * time split them whenever focus was in another group (e.g. a file opened beside the terminals).
   */
  private editorColumn(): vscode.ViewColumn {
    const groups = new Set(vscode.window.tabGroups.all.map((g) => g.viewColumn));
    const counts = new Map<vscode.ViewColumn, number>();
    for (const e of this.byPane.values()) if (live(e) && e.column && groups.has(e.column)) counts.set(e.column, (counts.get(e.column) ?? 0) + 1);
    const busiest = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (busiest) return busiest;
    if (this.lastColumn && groups.has(this.lastColumn)) return this.lastColumn;
    return vscode.window.tabGroups.activeTabGroup?.viewColumn ?? vscode.ViewColumn.One;
  }

  /**
   * Open (or show) the pane's tab. You asked for it here, so a tab showing it read-only takes control back;
   * `polite` (follow mode) leaves a pane another editor window has to that window and shows it read-only.
   */
  attach(pane: Pane, opts: { preserveFocus?: boolean; startingAs?: string; polite?: boolean } = {}): vscode.Terminal | undefined {
    const existing = this.byPane.get(pane.id);
    if (existing && live(existing)) {
      if (!opts.polite) existing.pty?.takeBack();
      existing.term.show(opts.preserveFocus);
      return existing.term;
    }
    // Its stream ended (Herdr stopped or restarted): replace the dead tab.
    if (existing) {
      existing.term.dispose();
      this.byPane.delete(pane.id);
    }
    const where = this.location();
    // editorSplit: agents in the first editor group, shells in the second (created when needed).
    const column = where === 'panel' ? undefined : where === 'editorSplit' ? (pane.isAgent ? vscode.ViewColumn.One : vscode.ViewColumn.Two) : this.editorColumn();
    const location = column === undefined ? vscode.TerminalLocation.Panel : { viewColumn: column, preserveFocus: !!opts.preserveFocus };
    const { name, iconPath } = this.look(pane, opts.startingAs);
    const pty = this.newPty(pane.id, { polite: opts.polite });
    const term = vscode.window.createTerminal({ name, pty, iconPath, location, isTransient: true });
    this.byPane.set(pane.id, { term, spaceId: pane.workspaceId, pty, column, name, seen: name });
    if (where === 'editor' && column) this.lastColumn = column;
    this.onChange();
    // An editor-area tab opens where `location` says. show() again could move it to the active group, so
    // only the panel needs it (createTerminal doesn't reveal the panel).
    if (column === undefined) term.show(opts.preserveFocus);
    return term;
  }

  /**
   * Track a terminal the editor created itself (the "+" button with a Herdr profile), so it counts as
   * attached, closes on space switch and is reused when you click its row.
   */
  adopt(paneId: string, spaceId: string, term: vscode.Terminal, pty?: HerdrPty, name = term.name) {
    this.byPane.set(paneId, { term, spaceId, pty, name, seen: term.name });
    if (name !== term.name) pty?.setName(name);
    this.onChange();
  }

  /** The space of a terminal we track, e.g. the active one. */
  spaceOf(term: vscode.Terminal | undefined): string | undefined {
    for (const e of this.byPane.values()) if (e.term === term) return e.spaceId;
  }

  /** Rename an open tab after its pane was renamed in Herdr, without focusing it. */
  rename(paneId: string, name: string) {
    const e = this.byPane.get(paneId);
    if (!e || e.name === name) return;
    e.name = name;
    e.pty?.setName(name);
  }

  /** Detach (close) tabs belonging to other spaces. */
  closeOtherSpaces(keepSpaceId: string) {
    this.closeWhere((e) => e.spaceId !== keepSpaceId);
  }

  /** Detach (close) this space's tabs, e.g. when the space moves to a window of its own. */
  closeSpace(spaceId: string) {
    this.closeWhere((e) => e.spaceId === spaceId);
  }

  /** Drop terminals whose pane no longer exists in Herdr. */
  prune(livePaneIds: Set<string>) {
    this.closeWhere((_, paneId) => !livePaneIds.has(paneId));
  }

  private closeWhere(pred: (e: Entry, paneId: string) => boolean) {
    let closed = false;
    for (const [k, e] of this.byPane) {
      if (pred(e, k)) {
        e.term.dispose();
        this.byPane.delete(k);
        closed = true;
      }
    }
    if (closed) this.onChange();
  }

  dispose() {
    this.sub.dispose();
    clearInterval(this.namePoll);
  }
}
