// A Herdr terminal tab: the extension draws it itself from `herdr terminal session control` (herdr attach
// can't be used: it turns on mouse reporting, so a drag couldn't select in shells; see CLAUDE.md). It handles the
// mouse like the Herdr TUI: drag / double-click / triple-click selects and copies, the wheel scrolls Herdr's
// scrollback, a drag held on the top or bottom row scrolls it and keeps selecting, and Backspace / Delete deletes a
// selection on the line being typed (typing replaces it), Option+click moves the cursor there, Shift+click extends
// the selection. Find (⌘F) searches the pane's whole history in Herdr (termFind.ts). See herdrStream.ts and
// termScreen.ts.
//
// One client controls a pane at a time. When another one takes it over (a Cockpit window in another editor,
// `herdr attach` in a terminal), the tab keeps showing the pane read-only (`herdr terminal session observe`) with a
// note on its bottom row saying who has it, and the first keystroke takes control back (that keystroke isn't
// sent: it could answer an agent's question).
import * as vscode from 'vscode';
import { errorText } from './herdrClient';
import { HerdrStream, isTakenOver, StreamMode } from './herdrStream';
import { FindController } from './termFindController';
import { InputToken, isDeleteKey, parseInput, POSTLUDE, PRELUDE, Screen, ScrollDir } from './termScreen';

export interface BuiltinDeps {
  binary(): string;
  env(): NodeJS.ProcessEnv;
  log(line: string): void;
  /** The stream ended on its own (Herdr stopped, the pane closed). */
  onEnded(): void;
  /** This tab is taking control of the pane: record it, so a window that loses it can say who has it. */
  claim?(paneId: string): void;
  /** This tab gave the pane up (closed, or lost it). */
  unclaim?(paneId: string): void;
  /** Which other editor window has the pane (its claim), if any; `since`: only claims newer than that. */
  holder?(paneId: string, since?: number): string | undefined;
  /**
   * Another client took the pane over: the tab now shows it read-only. `who` is undefined when unknown.
   * `expected`: another Cockpit window following the same space switch got there first (no need to notify).
   */
  onTakenOver?(paneId: string, who: string | undefined, expected: boolean): void;
  /** A Herdr socket request (find and Open Output read the pane's history). */
  request?<T = any>(method: string, params: object, timeoutMs?: number): Promise<T>;
  /** Copy a selection as soon as it's made (herdr.copyOnSelect); off, ⌘C / Ctrl+Shift+C copies it. */
  copyOnSelect?(): boolean;
}

/**
 * The tab's own keys (find, scrolling the history) arrive as this private sequence: the keybindings run
 * `workbench.action.terminal.sendSequence`, the one way to get a key past xterm.js (which keeps Shift+PageUp for
 * itself) and to the tab. Programs never see it.
 */
export const TAB_ACTIONS = ['find', 'find-next', 'find-previous', 'page-up', 'page-down', 'top', 'bottom', 'output', 'copy'] as const;
export type TabAction = (typeof TAB_ACTIONS)[number];
// eslint-disable-next-line no-control-regex -- the sequence is made of control characters
const ACTION_SEQ = /\x1b\]777;herdr-cockpit;([a-z-]+)\x07/g;

/** Typed text or a paste (not a control key): what replaces a selection on the line being typed. */
// eslint-disable-next-line no-control-regex -- control characters are what it excludes
const isTyped = (text: string) => /^(?:\x1b\[200~[\s\S]*\x1b\[201~|[^\x00-\x1f\x7f\x1b]+)$/.test(text);

type MouseToken = Extract<InputToken, { kind: 'mouse' }>;

/** A mouse report's modifier keys as Herdr's terminal.mouse wants them: shift 1, ctrl 2, alt 4. */
const modBits = (t: MouseToken) => Number(t.shift) | (Number(t.ctrl) << 1) | (Number(t.alt) << 2);

export interface PtyOptions {
  /** Don't take the pane from another editor window that has it: show it read-only instead (follow mode). */
  polite?: boolean;
}

const WHEEL_LINES = 3;
/** Matches listed by Tab in the find bar. */
const LIST_MAX = 5000;
/** Dragging on the top or bottom row: how long before it scrolls, and how often after that. */
const AUTOSCROLL_DELAY_MS = 200;
const AUTOSCROLL_EVERY_MS = 50;
const AUTOSCROLL_IDLE_MS = 150;
/** How long to wait for the frame that answers a scroll: none comes when the view can't move. */
const SCROLL_WAIT_MS = 250;
/**
 * Frames paint over the selection and the find bar, which are then drawn again: at most this often (a busy pane
 * sends many frames a second, and each repaint goes over every selected row).
 */
const REPAINT_MS = 16;

export class HerdrPty implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<number | void>();
  private readonly namer = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;
  /** Renames the tab without focusing it (unlike the rename command, which acts on the active terminal). */
  readonly onDidChangeName = this.namer.event;
  /** The pane this tab shows, once known (a "+" tab creates its pane when it opens). */
  paneId?: string;
  private stream?: HerdrStream;
  private screen?: Screen;
  /** Keeps model writes in frame order. Add to it with inFrameOrder(), which keeps it going after a step fails. */
  private queue: Promise<void> = Promise.resolve();
  private closedByUser = false;
  private toastTimer?: NodeJS.Timeout;
  /** The left button's press, to tell a click (sent to the program) from a drag (a selection). */
  private press?: { x: number; y: number; moved: boolean };
  /** The stream ended without the tab being closed: the tab now only shows a note. */
  ended = false;
  /** observe: another client has the pane and the tab shows it read-only. */
  private mode: StreamMode = 'control';
  /** Who has the pane while observing; undefined = not one of our windows. */
  private holderName?: string;
  /** When this tab last took control (claims older than that aren't the one who took it from us). */
  private controlSince = 0;
  private resizeTimer?: NodeJS.Timeout;
  /** Scrolling while a drag is held on the top or bottom row. */
  private auto?: { dir: ScrollDir; since: number; timer?: NodeJS.Timeout };
  private scrollWait?: NodeJS.Timeout;
  private repaintTimer?: NodeJS.Timeout;
  private readonly finder: FindController;

  /** The open find bar, if any (the editor test checks its matches). */
  get find() {
    return this.finder.state;
  }

  constructor(
    /** The pane id, or how to get it once the tab is open (create the pane then). */
    private readonly target: string | (() => Promise<string>),
    private readonly deps: BuiltinDeps,
    private readonly opts: PtyOptions = {},
  ) {
    if (typeof target === 'string') this.paneId = target;
    this.finder = new FindController({
      screen: () => this.screen,
      request: <T>(method: string, params: object, timeoutMs?: number) => this.request<T>(method, params, timeoutMs),
      write: (data) => this.writer.fire(data),
      log: (line) => this.deps.log(`built-in terminal ${this.paneId ?? '(new pane)'}: ${line}`),
      showList: () => this.listMatches(),
    });
  }

  setName(name: string) {
    this.namer.fire(name);
  }

  /** VS Code opened the tab. One it failed to draw never is: it stays empty, named after its internal id. */
  get opened(): boolean {
    return !!this.screen;
  }

  open(dims: vscode.TerminalDimensions | undefined): void {
    this.screen = new Screen(dims?.columns ?? 80, dims?.rows ?? 24);
    this.writer.fire(PRELUDE);
    if (typeof this.target === 'string') return this.start(this.target);
    this.target().then(
      (id) => {
        this.paneId = id;
        if (!this.closedByUser) this.start(id);
      },
      (e) => this.onStreamClosed(undefined, e instanceof Error ? e.message : String(e)),
    );
  }

  /** Control the pane, or (polite, and another window has it) watch it. */
  private start(target: string) {
    const who = this.opts.polite ? this.deps.holder?.(target) : undefined;
    if (!who) return this.connect(target, 'control');
    this.holderName = who;
    this.deps.log(`built-in terminal ${target}: ${who} has it; showing it read-only`);
    this.connect(target, 'observe');
  }

  /** The tab shows the pane read-only because another client has it. */
  get observing() {
    return this.mode === 'observe' && !this.ended && !this.closedByUser;
  }

  /** Take control of the pane back from whoever has it. */
  takeBack() {
    if (!this.observing || !this.paneId) return;
    this.deps.log(`built-in terminal ${this.paneId}: taking control back${this.holderName ? ` from ${this.holderName}` : ''}`);
    this.holderName = undefined;
    this.connect(this.paneId, 'control'); // its first frame repaints the whole screen, note included
  }

  /** The bottom-row note while observing. */
  private note(): string {
    const screen = this.screen;
    if (!screen || !this.observing) return '';
    const who = this.holderName ?? 'another Herdr client';
    return screen.toast(`${who[0].toUpperCase()}${who.slice(1)} is using this pane · type here to take it back`, 'note').paint;
  }

  private connect(target: string, mode: StreamMode) {
    const screen = this.screen!;
    const { cols, rows } = screen;
    this.stream?.release(); // a replaced stream's close is ignored below
    this.mode = mode;
    if (mode === 'control') {
      // Before Herdr hands it over, so the window losing it can read who took it.
      this.controlSince = Date.now();
      this.deps.claim?.(target);
    }
    const stream: HerdrStream = new HerdrStream(this.deps.binary(), target, { cols, rows }, this.deps.env(), {
      onFrame: (bytes) => {
        if (stream !== this.stream) return;
        this.writer.fire(bytes.toString('utf8') + (mode === 'observe' ? this.note() : ''));
        this.inFrameOrder(async () => {
          const before = screen.rowsOf();
          const moved = await screen.write(bytes);
          if (moved !== undefined) {
            return this.scrolled(before, moved);
          }
          // The frame may have painted over the selection or the find bar: show them again.
          this.repaintSoon();
        });
      },
      onClose: ({ reason, error }) => {
        if (stream === this.stream) this.onStreamClosed(reason, error);
      },
    }, mode);
    this.stream = stream;
  }

  /** Draw the selection or the find bar again after frames painted over them, once per REPAINT_MS at most. */
  private repaintSoon() {
    const screen = this.screen;
    if (this.repaintTimer || !screen || (!this.finder.active && !screen.hasSelection())) {
      return;
    }
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined;
      // Behind the frames already on their way to the model, so it paints what the tab shows.
      this.inFrameOrder(() => {
        if (this.closedByUser) {
          return;
        }
        if (this.finder.active) {
          this.finder.paint();
        } else if (screen.hasSelection()) {
          this.writer.fire(screen.paint(screen.rowsOf()));
        }
      });
    }, REPAINT_MS);
  }

  /** Clear the selection, and repaint the rows it was on. */
  private dropSelection(screen: Screen) {
    if (screen.hasSelection()) {
      this.writer.fire(screen.paint(screen.clearSelection()));
    }
  }

  /**
   * A left-button event on the screen: update the selection, repaint the rows it changed, and copy a finished one
   * (per herdr.copyOnSelect). Returns what Screen.mouse() returned.
   */
  private leftButton(screen: Screen, t: MouseToken): { repaint: number[]; copy?: string } {
    const r = screen.mouse(t);
    if (r.repaint.length) {
      let out = screen.paint(r.repaint);
      if (r.repaint.includes(screen.rows - 1)) {
        out += this.note(); // read-only: the note on the bottom row
      }
      this.writer.fire(out);
    }
    if (r.copy) {
      this.selectionMade(r.copy);
    }
    return r;
  }

  handleInput(data: string): void {
    const screen = this.screen;
    if (!screen || !this.stream || this.ended) return;
    const actions: string[] = [];
    data = data.replace(ACTION_SEQ, (_, a: string) => (actions.push(a), ''));
    for (const a of actions) if ((TAB_ACTIONS as readonly string[]).includes(a)) this.action(a as TabAction);
    if (!data) return;
    if (this.mode === 'observe') return this.observeInput(screen, data);
    if (this.finder.active) return this.findInput(screen, data);
    for (const t of parseInput(data)) {
      if (t.kind === 'data') {
        // Backspace / Delete on a selection in the line being typed deletes it; typing replaces it.
        const typed = isTyped(t.text);
        let keys: string | undefined;
        if (screen.hasSelection() && (typed || isDeleteKey(t.text))) {
          keys = screen.deleteKeys();
        }
        this.stopAutoScroll();
        this.dropSelection(screen);
        let out = t.text;
        if (keys && typed) {
          out = keys + t.text;
        } else if (keys) {
          out = keys;
        }
        this.soon(() => this.stream?.input(out));
        screen.inputSent();
      } else if (t.wheel) {
        this.stopAutoScroll();
        this.dropSelection(screen);
        screen.wheel(t.wheel);
        const dir = t.wheel;
        this.soon(() => this.stream?.scroll(dir, WHEEL_LINES));
      } else if (t.button === 0) {
        // Left button: a drag selects (like the Herdr TUI); a click without movement goes to the program,
        // so buttons in mouse-aware programs (Kiro) work. Herdr drops it for programs without the mouse.
        if (!t.release && !t.motion) {
          this.press = { x: t.x, y: t.y, moved: false };
        } else if (t.motion && this.press) {
          this.press.moved = true;
        }
        const r = this.leftButton(screen, t);
        this.autoScroll(screen);
        const click = t.release && this.press && !this.press.moved && !r.copy;
        // Option+click on the line being typed moves the cursor there.
        let move: string | undefined;
        if (click && t.alt) {
          move = screen.moveKeys(t.x, t.y);
        }
        if (move) {
          const keys = move;
          this.soon(() => this.stream?.input(keys));
          screen.inputSent();
        } else if (click && this.press) {
          const mods = modBits(t);
          this.stream.mouse('down', 'left', this.press.x, this.press.y, mods);
          this.stream.mouse('up', 'left', t.x, t.y, mods);
        }
        if (t.release) {
          this.press = undefined;
        }
      } else if ((t.button === 1 || t.button === 2) && !t.motion) {
        let action: 'down' | 'up' = 'down';
        if (t.release) {
          action = 'up';
        }
        let button: 'middle' | 'right' = 'right';
        if (t.button === 1) {
          button = 'middle';
        }
        this.stream.mouse(action, button, t.x, t.y, modBits(t));
      }
    }
  }

  /** Start or stop scrolling Herdr's view for a drag held on the top or bottom row. */
  private autoScroll(screen: Screen) {
    const dir = screen.edge();
    if (dir === this.auto?.dir) return;
    this.stopAutoScroll();
    if (!dir) return;
    const auto: { dir: ScrollDir; since: number; timer?: NodeJS.Timeout } = { dir, since: Date.now() };
    this.auto = auto;
    auto.timer = setTimeout(() => this.autoTick(auto), AUTOSCROLL_DELAY_MS);
  }

  /** One step: faster the longer the drag is held there. The next waits for this one's frame (scrolled()). */
  private autoTick(auto: NonNullable<HerdrPty['auto']>) {
    const screen = this.screen;
    if (auto !== this.auto || !screen || !this.stream || this.mode !== 'control') return;
    if (screen.edge() !== auto.dir) return this.stopAutoScroll(); // the selection went (a resize)
    const held = Date.now() - auto.since;
    let step = 10;
    if (held < 1500) {
      step = 1;
    } else if (held < 3000) {
      step = 3;
    }
    const lines = Math.max(1, Math.min(screen.rows - 1, step));
    // In the frame queue, so the frames before it are on the model first.
    this.inFrameOrder(() => {
      if (auto !== this.auto || !this.stream) return;
      screen.scrollSent(auto.dir, lines);
      this.stream.scroll(auto.dir, lines);
      clearTimeout(this.scrollWait);
      this.scrollWait = setTimeout(() => {
        this.inFrameOrder(() => {
          const before = screen.rowsOf();
          const moved = screen.scrollTimedOut();
          if (moved !== undefined) this.scrolled(before, moved);
        });
      }, SCROLL_WAIT_MS);
    });
  }

  /**
   * Run `step` after the frames and steps before it. A step that throws is logged and the next ones still run:
   * left rejected, the chain would skip every later frame (no selection, find or autoscroll for the tab's life).
   */
  private inFrameOrder(step: () => unknown) {
    this.queue = this.queue.then(step).then(
      () => undefined,
      (e) => {
        this.deps.log(`built-in terminal ${this.paneId ?? '(new pane)'}: ${errorText(e)}`);
      },
    );
  }

  /** Herdr's view moved `lines` for a scroll we sent (0: it couldn't): show the selection, scroll on. */
  private scrolled(before: number[], lines: number) {
    clearTimeout(this.scrollWait);
    const screen = this.screen;
    if (!screen) return;
    const rows = [...new Set([...before, ...screen.rowsOf()])];
    if (rows.length) this.writer.fire(screen.paint(rows));
    const auto = this.auto;
    if (!auto) return;
    // Didn't move (the end of the scrollback, or the program ignored it): keep trying while the drag is held there.
    let wait = AUTOSCROLL_IDLE_MS;
    if (lines) {
      wait = AUTOSCROLL_EVERY_MS;
    }
    auto.timer = setTimeout(() => this.autoTick(auto), wait);
  }

  private stopAutoScroll() {
    clearTimeout(this.auto?.timer);
    this.auto = undefined;
  }

  // ---------- the tab's own keys ----------

  /** Run one of the tab's actions (a keybinding or a command). */
  action(a: TabAction) {
    const screen = this.screen;
    if (a === 'copy') {
      // Works read-only and after the stream ended too: the selection is on our copy of the screen.
      if (screen?.hasSelection()) {
        const text = screen.selectionText();
        if (text) {
          this.copied(text);
        }
      }
      return;
    }
    if (!screen || !this.stream || this.ended) return;
    switch (a) {
      case 'find':
        return this.openFind();
      // Like Enter / ↑ in the bar: older first, as the search starts from the bottom.
      case 'find-next':
      case 'find-previous': {
        if (!this.finder.active) {
          return this.openFind();
        }
        if (a === 'find-next') {
          return this.finder.step(-1);
        }
        return this.finder.step(1);
      }
      case 'output':
        return void this.openOutput();
      default:
        return this.scrollView(a);
    }
  }

  /** Page Up / Page Down / Top / Bottom in Herdr's history. */
  private scrollView(a: 'page-up' | 'page-down' | 'top' | 'bottom') {
    const screen = this.screen!;
    if (this.mode !== 'control') return;
    const page = Math.max(1, screen.rows - 1);
    // While finding, Herdr's view is moved through the socket, so it stays known (the highlights are placed from it).
    if (this.finder.scrollView(a, page)) {
      return;
    }
    this.dropSelection(screen);
    if (a === 'bottom') {
      this.soon(() => this.stream?.scroll('down', 65535));
      return screen.inputSent();
    }
    screen.scrolledAway();
    if (a === 'top') {
      this.soon(() => this.stream?.scroll('up', 65535));
    } else if (a === 'page-up') {
      this.soon(() => this.stream?.scroll('up', page));
    } else {
      this.soon(() => this.stream?.scroll('down', page));
    }
  }

  // ---------- find (termFindController.ts) ----------

  /** Run now, unless find's view changes are still on their way: then after them. */
  private soon(fn: () => void) {
    this.finder.soon(fn);
  }

  private request<T = any>(method: string, params: object, timeoutMs?: number): Promise<T> {
    if (!this.deps.request || !this.paneId) return Promise.reject(new Error('not connected to Herdr'));
    return this.deps.request<T>(method, { pane_id: this.paneId, ...params }, timeoutMs);
  }

  /** Open the find bar (⌘F). Searching scrolls Herdr's view, so it needs control of the pane. */
  openFind() {
    const screen = this.screen;
    if (!screen || this.ended || !this.paneId || !this.deps.request) return;
    if (this.mode !== 'control') {
      this.writer.fire(screen.toast('Type here to take the pane back, then search', 'note').paint);
      return;
    }
    this.stopAutoScroll();
    this.finder.open();
  }

  /** Input while the find bar is open: keys go to the bar; the mouse still selects, the wheel scrolls the view. */
  private findInput(screen: Screen, data: string) {
    for (const t of parseInput(data)) {
      if (t.kind === 'data') {
        this.finder.key(t.text);
        if (!this.finder.active) {
          return; // Escape closed it: what came with it isn't typed into the pane
        }
      } else if (t.wheel) {
        this.finder.wheel(t.wheel, WHEEL_LINES);
      } else if (t.button === 0) {
        this.leftButton(screen, t);
        this.autoScroll(screen);
      }
    }
  }

  /** Tab in the find bar: every match in a list; moving through it previews, Enter stays there. */
  private listMatches() {
    const list = this.finder.list(LIST_MAX);
    if (!list) {
      return;
    }
    type Item = vscode.QuickPickItem & { i: number };
    const items: Item[] = list.items.map((m, i) => ({ label: m.label || ' ', description: `row ${m.row + 1}`, i }));
    const qp = vscode.window.createQuickPick<Item>();
    let plural = 'es';
    if (list.total === 1) {
      plural = '';
    }
    let shown = '';
    if (list.total > LIST_MAX) {
      shown = ` (first ${LIST_MAX})`;
    }
    qp.title = `${list.total} match${plural} for “${list.query}”${shown}`;
    qp.placeholder = 'Type to filter the matching lines; Enter goes there';
    qp.items = items;
    const start = items[Math.min(list.current, items.length - 1)];
    if (start) {
      qp.activeItems = [start];
    }
    let ready = false;
    qp.onDidChangeActive(([it]) => {
      if (ready && it) {
        list.jump(it.i);
      }
    });
    qp.onDidAccept(() => qp.hide());
    qp.onDidHide(() => qp.dispose());
    qp.show();
    setTimeout(() => (ready = true), 50); // setting activeItems fires a change: not a move
  }

  /** The pane's whole history as an editor document, to search and select with the editor. */
  async openOutput() {
    if (!this.screen || !this.deps.request || !this.paneId) return;
    try {
      const text = await this.finder.readHistory();
      const doc = await vscode.workspace.openTextDocument({ content: text.lines.join('\n').replace(/\s+$/, '') + '\n', language: 'log' });
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      const end = new vscode.Position(doc.lineCount - 1, 0);
      ed.selection = new vscode.Selection(end, end);
      ed.revealRange(new vscode.Range(end, end));
    } catch (e) {
      void vscode.window.showWarningMessage(`Couldn't read this pane's output from Herdr: ${errorText(e)}`);
    }
  }

  /** Read-only: selecting and copying still work; typing takes control back (the keystroke isn't sent). */
  private observeInput(screen: Screen, data: string) {
    for (const t of parseInput(data)) {
      if (t.kind === 'data') return this.takeBack();
      if (t.button !== 0 || t.wheel) continue; // the wheel scrolls Herdr's scrollback: only a controller can
      this.leftButton(screen, t);
    }
  }

  /** A selection was finished (a drag, a double or triple click): copy it, unless herdr.copyOnSelect is off. */
  private selectionMade(text: string) {
    if (this.deps.copyOnSelect?.() ?? false) {
      this.copied(text);
    }
  }

  /** Copy to the clipboard and say so: a toast in the tab (like the Herdr TUI) and the status bar. */
  private copied(text: string) {
    void vscode.env.clipboard.writeText(text);
    const n = text.length;
    vscode.window.setStatusBarMessage(`$(copy) Copied ${n} character${n === 1 ? '' : 's'} to the clipboard`, 2500);
    const screen = this.screen;
    if (!screen) return;
    const t = screen.toast('✓ Copied to clipboard');
    this.writer.fire(t.paint);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (!this.closedByUser && !this.ended) this.writer.fire(screen.paint([t.row]) + this.note());
    }, 1500);
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.screen?.resize(dims.columns, dims.rows);
    if (this.mode === 'control') return this.stream?.resize(dims.columns, dims.rows); // Herdr answers with a full frame
    // An observer draws at the size it started with: start a new one (after the resize settles).
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.observing && this.paneId) this.connect(this.paneId, 'observe');
    }, 150);
  }

  close(): void {
    this.closedByUser = true;
    this.stopAutoScroll();
    this.finder.dispose();
    clearTimeout(this.scrollWait);
    clearTimeout(this.toastTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.repaintTimer);
    if (this.mode === 'control' && this.paneId) this.deps.unclaim?.(this.paneId);
    this.stream?.release();
    this.screen?.dispose();
    this.writer.dispose();
    this.closer.dispose();
    this.namer.dispose();
  }

  private onStreamClosed(reason?: string, error?: string) {
    if (this.closedByUser) return;
    this.stopAutoScroll();
    if (this.mode === 'control' && this.paneId) {
      this.deps.unclaim?.(this.paneId);
      if (isTakenOver(reason)) return this.lostControl(this.paneId);
    }
    this.ended = true;
    let why = `the stream ended (${reason ?? 'closed'})`;
    if (error) {
      why = `couldn't stream this pane: ${error}`;
    } else if (reason === 'detached') {
      why = 'detached';
    }
    this.deps.log(`built-in terminal ${this.paneId ?? '(new pane)'}: ${why}`);
    this.writer.fire(`${POSTLUDE}\r\n\x1b[2m[Herdr Cockpit] ${why}. Close this tab, or click the pane in the sidebar to open it again.\x1b[0m\r\n`);
    this.deps.onEnded();
  }

  /** Another client took the pane: keep showing it, read-only, and say who has it. */
  private lostControl(paneId: string) {
    const who = this.deps.holder?.(paneId, this.controlSince);
    this.holderName = who;
    this.deps.log(`built-in terminal ${paneId}: taken over by ${who ?? 'another Herdr client'}; showing it read-only`);
    this.connect(paneId, 'observe');
    const expected = !!this.opts.polite && !!who && Date.now() - this.controlSince < 5000;
    this.deps.onTakenOver?.(paneId, who, expected);
  }
}
