// This window's Herdr tabs across reloads (herdr.restoreTabs), and what ⇧⌘T reopens (herdr.reopenClosedTab).
// Moved out of extension.ts's activate(); the tab order itself is terminals.ts (panes(), arrange()).
import * as vscode from 'vscode';
import { errorText } from '../util/errors';
import { sleep } from '../util/format';
import { allPanes, Model, Pane } from '../state/model';
import type { ClosedTab } from '../commands/manage';
import type { AttachTerminals } from './terminals';

/** The panes this window had tabs for, to reopen them when the window opens again (herdr.restoreTabs). */
const OPEN_TABS_KEY = 'herdr.openTabs';
/** How long after reopening them to look for tabs VS Code failed to draw. */
const UNDRAWN_CHECK_MS = 3000;
/** How many times to look (and replace) before giving up. */
const UNDRAWN_ATTEMPTS = 3;
const CLOSED_HISTORY_MAX = 50;

/** The editor's Welcome / walkthrough page: a tab without an input, known only by its label (English UI). */
export const isWelcomeTab = (t: vscode.Tab) => t.input === undefined && /^(Welcome|Get(ting)? Started)\b/.test(t.label);

export interface TabRestoreDeps {
  state: vscode.Memento;
  terms: AttachTerminals;
  model(): Model | undefined;
  enabled(): boolean;
  /** The name a pane's tab gets (tabName() in viewState.ts). */
  tabName(pane: Pane): string;
  log(line: string): void;
}

/**
 * The terminals among `all` that run no process of their own (pseudoterminals, like our tabs). VS Code reports a
 * pseudoterminal's processId as -1 (undefined in some versions); a shell has a real pid. One that doesn't answer
 * within 500ms (a leftover of a stopped extension host may not) counts as ours too: a shell answers at once.
 */
async function drawnTerminals(all: vscode.Terminal[]): Promise<vscode.Terminal[]> {
  const pids = await Promise.all(all.map((t) => Promise.race([Promise.resolve(t.processId), sleep(500).then(() => 'no answer' as const)])));
  return all.filter((_, i) => {
    const pid = pids[i];
    return pid === undefined || pid === 'no answer' || pid <= 0;
  });
}

export class TabRestore implements vscode.Disposable {
  /** Restored (or nothing to restore): until then, the saved list is the one from the last session. */
  private restored = false;
  /** Tabs are still being reopened, redrawn and put back in order: what the tab bar shows isn't their order yet. */
  private arranging = false;
  /**
   * What ⇧⌘T should reopen, newest last: a Herdr tab, or "editor" for any other editor tab, which only
   * VS Code's Reopen Closed Editor can bring back. VS Code can't rebuild our tabs (their stream belongs to
   * this extension), so herdr.reopenClosedTab replaces that command and hands "editor" entries to it.
   */
  private closedHistory: (ClosedTab | 'editor')[] = [];
  private sub: vscode.Disposable;

  constructor(private deps: TabRestoreDeps) {
    this.sub = vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        if (reopenableEditor(tab, e.opened)) {
          this.remember('editor');
        }
      }
      // A tab dragged to another place (or opened) changes the order to reopen them in. Not on closes: while the
      // window closes, its tabs leave the tab bar before their terminals are gone.
      if (!e.closed.length && this.deps.terms.count()) {
        this.save();
      }
    });
  }

  /** Remember this window's tabs. Not while it closes: those tabs go with the window and should come back. */
  save() {
    const { terms } = this.deps;
    if (!this.restored || this.arranging || terms.shuttingDown) {
      return;
    }
    void this.deps.state.update(OPEN_TABS_KEY, terms.panes());
  }

  /**
   * Reopen the tabs this window had when it was closed, once Herdr answers. Panes that are gone (closed, or
   * Herdr restarted with new ids) are skipped. A pane another window has stays there, shown read-only here.
   */
  async restore() {
    if (this.restored) {
      return;
    }
    this.restored = true;
    if (!this.deps.enabled()) {
      return;
    }
    const { terms, log } = this.deps;
    const saved = this.deps.state.get<{ paneId: string; spaceId: string }[]>(OPEN_TABS_KEY, []);
    const panes = new Map(allPanes(this.deps.model()).map(({ pane }) => [pane.id, pane] as const));
    const reopened: Pane[] = [];
    // After Restart Extensions the window keeps the tabs the previous run opened, but they no longer show their
    // pane (it belonged to the extension host that stopped): close the one a reopened tab replaces, matched by name.
    // Only terminals with no process of their own: a Herdr tab is drawn by the extension (a pseudoterminal), while
    // your own terminals and other extensions' run a shell. Without this one you'd named "Claude" would be closed.
    // Not asked when there's nothing to restore.
    let leftovers: vscode.Terminal[] = [];
    if (saved.some(({ paneId }) => panes.has(paneId))) {
      leftovers = await drawnTerminals(terms.untracked());
    }
    let replaced = 0;
    for (const { paneId } of saved) {
      const pane = panes.get(paneId);
      if (!pane) {
        continue;
      }
      // The previous run's tab of this pane goes, also when the pane got a new tab meanwhile (a click while restore
      // waited): it would stay next to it, blank.
      const name = this.deps.tabName(pane);
      const old = leftovers.findIndex((t) => t.name === name);
      if (old >= 0) {
        leftovers.splice(old, 1)[0].dispose();
        replaced++;
      }
      if (!terms.has(paneId)) {
        terms.attach(pane, { preserveFocus: true, polite: true });
        reopened.push(pane);
      }
    }
    if (saved.length) {
      log(`reopened ${reopened.length} of ${saved.length} tabs from the last session (${replaced} replacing tabs left from before a restart)`);
    }
    this.save();
    if (!reopened.length) {
      return;
    }
    this.arranging = true;
    const order = saved.map((s) => s.paneId);
    setTimeout(
      () =>
        this.redrawUndrawn(reopened, 1, () => {
          void terms
            .arrange(order)
            .then((problem) => {
              if (problem) {
                log(`ordering reopened tabs stopped: ${problem}`);
              }
            })
            .catch((e) => log(`ordering reopened tabs: ${errorText(e)}`))
            .finally(() => {
              this.arranging = false;
              this.save();
            });
        }),
      UNDRAWN_CHECK_MS,
    );
  }

  /**
   * Tabs created while the window is still starting can come out broken, empty and named after their internal id
   * ("e7ab…bf1"), in two ways:
   * - VS Code can't show terminals in the editor area yet, so it opens the tab as a text file of the terminal's
   *   `vscode-terminal:` address ("Unable to resolve resource vscode-terminal:/…" in its log). The terminal works,
   *   but no tab shows it, and the API can't tell which terminal a broken tab was for: replace them all.
   * - VS Code fails to draw the terminal ("A container element needs to be set with `attachToElement`…") and
   *   never opens it.
   * Look again after replacing, a few times, in case the window still wasn't ready. Then `done`.
   */
  private redrawUndrawn(panes: Pane[], attempt: number, done: () => void) {
    const { terms, log } = this.deps;
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
      done();
      return;
    }
    log(`replacing ${broken.length} tab(s) VS Code didn't draw (${textTabs.length} opened as text), attempt ${attempt}`);
    void vscode.window.tabGroups.close(textTabs, true).then(
      () => {
        for (const p of broken) {
          terms.replace(p, { preserveFocus: true, polite: true });
        }
        if (attempt < UNDRAWN_ATTEMPTS) {
          setTimeout(() => this.redrawUndrawn(broken, attempt + 1, done), UNDRAWN_CHECK_MS);
        } else {
          done();
        }
      },
      (e) => {
        log(`closing broken tabs: ${errorText(e)}`);
        done();
      },
    );
  }

  /** A tab you closed: a Herdr tab (to reopen its pane) or 'editor' (VS Code reopens it). */
  remember(entry: ClosedTab | 'editor') {
    this.closedHistory.push(entry);
    if (this.closedHistory.length > CLOSED_HISTORY_MAX) {
      this.closedHistory.shift();
    }
  }

  /** The newest closed tab, taken off the history; undefined when there's none. */
  takeClosed(): ClosedTab | 'editor' | undefined {
    return this.closedHistory.pop();
  }

  dispose() {
    this.sub.dispose();
  }
}

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
