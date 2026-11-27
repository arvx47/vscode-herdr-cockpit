// A terminal tab showing one pane, whichever driver runs it (HerdrPty, builtinTerminal.ts, for Herdr).
// AttachTerminals (terminals.ts) only sees this.
import type * as vscode from 'vscode';

/**
 * A tab's own keys (find, scrolling the history; only tabs with ownKeys) arrive as a private sequence that
 * HerdrPty strips: the keybindings run `workbench.action.terminal.sendSequence`, the one way to get a key past
 * xterm.js (which keeps Shift+PageUp for itself) and to the tab. Programs never see it.
 */
export const TAB_ACTIONS = ['find', 'find-next', 'find-previous', 'page-up', 'page-down', 'top', 'bottom', 'output', 'copy', 'new-shell'] as const;
export type TabAction = (typeof TAB_ACTIONS)[number];

/** How a tab is opened. */
export interface PtyOptions {
  /** Don't take the pane from another editor window that has it: show it read-only instead (follow mode). */
  polite?: boolean;
}

export interface PaneTab extends vscode.Pseudoterminal {
  /** The pane this tab shows, once known (a "+" tab creates its pane when it opens). */
  paneId?: string;
  /** It no longer shows its pane (the stream or the pane ended) but the tab is still open, with a note. */
  readonly ended: boolean;
  /** VS Code opened the tab (one it failed to draw never is). */
  readonly opened: boolean;
  /**
   * The tab handles find, history scrolling and copying itself (its keybindings, `herdr.terminalActive`); else
   * VS Code's own terminal does, on what the tab drew.
   */
  readonly ownKeys: boolean;
  /** Rename the tab without focusing it. */
  setName(name: string): void;
  /** Take control back from another client that has the pane (Herdr); nothing for a driver without others. */
  takeBack(): void;
  /** One of the tab's own keys (only when ownKeys). */
  action(a: TabAction): void;
}

/** Makes a driver's tab: for a pane id, or for a pane to create once the tab opens. `onEnded`: see `ended`. */
export type TabFactory = (target: string | (() => Promise<string>), opts: PtyOptions, onEnded: () => void) => PaneTab;
