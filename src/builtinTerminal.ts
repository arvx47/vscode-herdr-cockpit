// The built-in Herdr terminal (herdr.terminalClient = "builtin"): a tab the extension draws itself from
// `herdr terminal session control`, instead of running `herdr agent/terminal attach` in it. It handles the
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
import { HerdrStream, isTakenOver, StreamMode } from './herdrStream';
import { compileQuery, findMatches, Match, offsetFor, PaneText, startAt } from './termFind';
import { isDeleteKey, parseInput, POSTLUDE, PRELUDE, Screen, ScrollDir } from './termScreen';

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
}

/**
 * The tab's own keys (find, scrolling the history) arrive as this private sequence: the keybindings run
 * `workbench.action.terminal.sendSequence`, the one way to get a key past xterm.js (which keeps Shift+PageUp for
 * itself) and to the tab. Programs never see it.
 */
export const TAB_ACTIONS = ['find', 'find-next', 'find-previous', 'page-up', 'page-down', 'top', 'bottom', 'output'] as const;
export type TabAction = (typeof TAB_ACTIONS)[number];
// eslint-disable-next-line no-control-regex -- the sequence is made of control characters
const ACTION_SEQ = /\x1b\]777;herdr-cockpit;([a-z-]+)\x07/g;
export const actionSequence = (a: TabAction) => `\x1b]777;herdr-cockpit;${a}\x07`;

/** Typed text or a paste (not a control key): what replaces a selection on the line being typed. */
// eslint-disable-next-line no-control-regex -- control characters are what it excludes
const isTyped = (text: string) => /^(?:\x1b\[200~[\s\S]*\x1b\[201~|[^\x00-\x1f\x7f\x1b]+)$/.test(text);

interface PaneScroll {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

/** The find bar's state. Rows are the history's (0 = oldest); `view` is Herdr's view as last answered. */
interface FindState {
  query: string;
  matches: Match[];
  /** Index into matches (oldest first), -1 for none. */
  cur: number;
  error?: string;
  text?: PaneText;
  view?: PaneScroll;
  /** Rows the line wrapping guessed wrong by (corrected from the screen after a jump). */
  drift: number;
  /** Check the current match against the screen once its frame is in. */
  verify: number;
  /** Mark rows painted last (to clear them). */
  painted: number[];
  timer?: NodeJS.Timeout;
  seq: number;
}

export interface PtyOptions {
  /** Don't take the pane from another editor window that has it: show it read-only instead (follow mode). */
  polite?: boolean;
}

const WHEEL_LINES = 3;
/** Typing in the find bar: wait this long before searching. */
const FIND_DEBOUNCE_MS = 120;
/** Matches listed by Tab in the find bar. */
const LIST_MAX = 5000;
/** Dragging on the top or bottom row: how long before it scrolls, and how often after that. */
const AUTOSCROLL_DELAY_MS = 200;
const AUTOSCROLL_EVERY_MS = 50;
const AUTOSCROLL_IDLE_MS = 150;
/** How long to wait for the frame that answers a scroll: none comes when the view can't move. */
const SCROLL_WAIT_MS = 250;

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
  /** Keeps model writes in frame order. */
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
  private find?: FindState;
  /**
   * Find moves Herdr's view with socket requests, keys and the wheel go through the stream: a jump still on its way
   * must land before input made after it (Esc, then typing or Bottom, was scrolled back to the match once).
   */
  private viewQueue: Promise<unknown> = Promise.resolve();
  private viewPending = 0;
  /** The last query, offered when the find bar opens again. */
  private lastQuery = '';

  constructor(
    /** The pane id, or how to get it once the tab is open (create the pane then). */
    private readonly target: string | (() => Promise<string>),
    private readonly deps: BuiltinDeps,
    private readonly opts: PtyOptions = {},
  ) {
    if (typeof target === 'string') this.paneId = target;
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
        this.queue = this.queue.then(async () => {
          const before = screen.rowsOf();
          const moved = await screen.write(bytes);
          if (moved !== undefined) return this.scrolled(before, moved);
          // The frame may have painted over the selection or the find bar: show them again.
          if (this.find) return this.paintFind();
          if (screen.hasSelection()) this.writer.fire(screen.paint(screen.rowsOf()));
        });
      },
      onClose: ({ reason, error }) => {
        if (stream === this.stream) this.onStreamClosed(reason, error);
      },
    }, mode);
    this.stream = stream;
  }

  handleInput(data: string): void {
    const screen = this.screen;
    if (!screen || !this.stream || this.ended) return;
    const actions: string[] = [];
    data = data.replace(ACTION_SEQ, (_, a: string) => (actions.push(a), ''));
    for (const a of actions) if ((TAB_ACTIONS as readonly string[]).includes(a)) this.action(a as TabAction);
    if (!data) return;
    if (this.mode === 'observe') return this.observeInput(screen, data);
    if (this.find) return this.findInput(screen, data);
    for (const t of parseInput(data)) {
      if (t.kind === 'data') {
        // Backspace / Delete on a selection in the line being typed deletes it; typing replaces it.
        const typed = isTyped(t.text);
        const keys = screen.hasSelection() && (typed || isDeleteKey(t.text)) ? screen.deleteKeys() : undefined;
        this.stopAutoScroll();
        if (screen.hasSelection()) this.writer.fire(screen.paint(screen.clearSelection()));
        const out = keys ? keys + (typed ? t.text : '') : t.text;
        this.soon(() => this.stream?.input(out));
        screen.inputSent();
      } else if (t.wheel) {
        this.stopAutoScroll();
        if (screen.hasSelection()) this.writer.fire(screen.paint(screen.clearSelection()));
        screen.wheel(t.wheel);
        const dir = t.wheel;
        this.soon(() => this.stream?.scroll(dir, WHEEL_LINES));
      } else if (t.button === 0) {
        // Left button: a drag selects (like the Herdr TUI); a click without movement goes to the program,
        // so buttons in mouse-aware programs (Kiro) work. Herdr drops it for programs without the mouse.
        if (!t.release && !t.motion) this.press = { x: t.x, y: t.y, moved: false };
        else if (t.motion && this.press) this.press.moved = true;
        const r = screen.mouse(t);
        if (r.repaint.length) this.writer.fire(screen.paint(r.repaint));
        if (r.copy) this.copied(r.copy);
        this.autoScroll(screen);
        // Option+click on the line being typed moves the cursor there.
        const move = t.release && t.alt && this.press && !this.press.moved && !r.copy ? screen.moveKeys(t.x, t.y) : undefined;
        if (move) {
          this.soon(() => this.stream?.input(move));
          screen.inputSent();
        } else if (t.release && this.press && !this.press.moved && !r.copy) {
          const mods = (t.shift ? 1 : 0) | (t.ctrl ? 2 : 0) | (t.alt ? 4 : 0);
          this.stream.mouse('down', 'left', this.press.x, this.press.y, mods);
          this.stream.mouse('up', 'left', t.x, t.y, mods);
        }
        if (t.release) this.press = undefined;
      } else if ((t.button === 1 || t.button === 2) && !t.motion) {
        const mods = (t.shift ? 1 : 0) | (t.ctrl ? 2 : 0) | (t.alt ? 4 : 0);
        this.stream.mouse(t.release ? 'up' : 'down', t.button === 1 ? 'middle' : 'right', t.x, t.y, mods);
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
    const lines = Math.max(1, Math.min(screen.rows - 1, held < 1500 ? 1 : held < 3000 ? 3 : 10));
    // In the frame queue, so the frames before it are on the model first.
    this.queue = this.queue.then(() => {
      if (auto !== this.auto || !this.stream) return;
      screen.scrollSent(auto.dir, lines);
      this.stream.scroll(auto.dir, lines);
      clearTimeout(this.scrollWait);
      this.scrollWait = setTimeout(() => {
        this.queue = this.queue.then(() => {
          const before = screen.rowsOf();
          const moved = screen.scrollTimedOut();
          if (moved !== undefined) this.scrolled(before, moved);
        });
      }, SCROLL_WAIT_MS);
    });
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
    auto.timer = setTimeout(() => this.autoTick(auto), lines ? AUTOSCROLL_EVERY_MS : AUTOSCROLL_IDLE_MS);
  }

  private stopAutoScroll() {
    clearTimeout(this.auto?.timer);
    this.auto = undefined;
  }

  // ---------- the tab's own keys ----------

  /** Run one of the tab's actions (a keybinding or a command). */
  action(a: TabAction) {
    const screen = this.screen;
    if (!screen || !this.stream || this.ended) return;
    switch (a) {
      case 'find':
        return this.openFind();
      // Like Enter / ↑ in the bar: older first, as the search starts from the bottom.
      case 'find-next':
        return this.find ? this.step(-1) : this.openFind();
      case 'find-previous':
        return this.find ? this.step(1) : this.openFind();
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
    const f = this.find;
    if (f?.view && this.deps.request && this.paneId) {
      // While finding, keep Herdr's view known (the highlights are placed from it).
      const v = f.view;
      const to = a === 'top' ? v.max_offset_from_bottom : a === 'bottom' ? 0 : v.offset_from_bottom + (a === 'page-up' ? page : -page);
      return void this.scrollTo(f, Math.min(v.max_offset_from_bottom, Math.max(0, to)));
    }
    if (screen.hasSelection()) this.writer.fire(screen.paint(screen.clearSelection()));
    if (a === 'bottom') {
      this.soon(() => this.stream?.scroll('down', 65535));
      return screen.inputSent();
    }
    screen.scrolledAway();
    if (a === 'top') this.soon(() => this.stream?.scroll('up', 65535));
    else this.soon(() => this.stream?.scroll(a === 'page-up' ? 'up' : 'down', page));
  }

  // ---------- find ----------

  /** Queue a change of Herdr's view behind the ones still on their way. */
  private inOrder<T>(fn: () => T | Promise<T>): Promise<T> {
    this.viewPending++;
    const p = this.viewQueue.then(fn).finally(() => this.viewPending--);
    this.viewQueue = p.catch(() => undefined);
    return p;
  }
  /** Run now, unless find's view changes are still on their way: then after them. */
  private soon(fn: () => void) {
    if (this.viewPending) void this.inOrder(fn);
    else fn();
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
    if (!this.find) this.find = { query: this.lastQuery, matches: [], cur: -1, drift: 0, verify: 0, painted: [], seq: 0 };
    this.paintFind();
    if (this.find.query) this.searchSoon(0);
  }

  /** Close the find bar. The view stays where it is (typing returns to the live screen). */
  closeFind() {
    const f = this.find;
    const screen = this.screen;
    if (!f || !screen) return;
    clearTimeout(f.timer);
    this.lastQuery = f.query;
    this.find = undefined;
    screen.setMarks([]);
    this.writer.fire(screen.paint([...new Set([0, ...f.painted])]));
  }

  /** Keys while the find bar is open: they edit the query and move between matches; the mouse still selects. */
  private findInput(screen: Screen, data: string) {
    const f = this.find!;
    for (const t of parseInput(data)) {
      if (t.kind === 'mouse') {
        if (t.wheel) {
          const v = f.view;
          if (v) void this.scrollTo(f, Math.min(v.max_offset_from_bottom, Math.max(0, v.offset_from_bottom + (t.wheel === 'up' ? WHEEL_LINES : -WHEEL_LINES))));
        } else if (t.button === 0) {
          const r = screen.mouse(t);
          if (r.repaint.length) this.writer.fire(screen.paint(r.repaint));
          if (r.copy) this.copied(r.copy);
          this.autoScroll(screen);
        }
        continue;
      }
      let q = f.query;
      const text = t.text;
      for (let i = 0; i < text.length; ) {
        const rest = text.slice(i);
        let m: RegExpExecArray | null;
        if (rest.startsWith('\x1b[200~')) {
          // A paste: its first line goes into the query.
          const end = rest.indexOf('\x1b[201~');
          q += rest.slice(6, end < 0 ? undefined : end).split(/\r\n|\r|\n/)[0];
          i += end < 0 ? rest.length : end + 6;
          // eslint-disable-next-line no-control-regex -- an escape sequence (arrow keys)
        } else if ((m = /^\x1b(?:\[[0-9;?]*([A-Za-z~])|O([A-Za-z]))/.exec(rest))) {
          const key = m[1] ?? m[2];
          if (key === 'A') this.step(-1);
          else if (key === 'B') this.step(1);
          i += m[0].length;
        } else if (rest[0] === '\x1b' || rest[0] === '\x03') {
          if (rest[0] === '\x1b' && rest[1] === '\r') {
            this.step(1); // Option/Alt+Enter: newer
            i += 2;
            continue;
          }
          return this.closeFind(); // Escape, Ctrl+C
        } else {
          const ch = String.fromCodePoint(rest.codePointAt(0)!);
          i += ch.length;
          if (ch === '\r') this.step(-1); // Enter: older (upwards from the bottom, like the editor's terminal find)
          else if (ch === '\t') void this.listMatches();
          else if (ch === '\x7f' || ch === '\b') q = [...q].slice(0, -1).join('');
          else if (ch === '\x15') q = '';
          else if (ch === '\x17') q = q.replace(/\S*\s*$/, '');
          else if (ch >= ' ') q += ch;
        }
      }
      if (q !== f.query) {
        f.query = q;
        this.paintFind();
        this.searchSoon(FIND_DEBOUNCE_MS);
      }
    }
  }

  private searchSoon(ms: number) {
    const f = this.find;
    if (!f) return;
    clearTimeout(f.timer);
    f.timer = setTimeout(() => void this.search(f), ms);
  }

  /** Read the pane's history (again, when its content changed). */
  private async loadText(f: { text?: PaneText; view?: PaneScroll }): Promise<void> {
    const rev = (await this.request<{ content_revision: number }>('pane.copy_motion', { cursor: { row: 0, col: 0 }, motion: 'line_end' })).content_revision;
    const view = (await this.request<{ pane: { scroll?: PaneScroll } }>('pane.get', {})).pane.scroll;
    if (!view) throw new Error('Herdr gave no scroll position for this pane');
    f.view = view;
    if (f.text && f.text.revision === rev) return;
    const cols = this.screen!.cols;
    const last = view.max_offset_from_bottom + view.viewport_rows - 1;
    const read = (col: number) => this.request<{ text: string }>('pane.selection.read', { anchor: { row: 0, col: 0 }, cursor: { row: last, col } }, 30_000);
    const r = await read(cols - 1).catch(() => read(0)); // a narrower pane than the tab: drop the last row's tail
    f.text = new PaneText(r.text.split('\n'), cols, rev);
  }

  private async search(f: FindState) {
    if (f !== this.find) return;
    const seq = ++f.seq;
    const re = compileQuery(f.query);
    if (!re || re instanceof Error) {
      f.matches = [];
      f.cur = -1;
      f.error = re instanceof Error ? 'Invalid regular expression' : undefined;
      return this.paintFind();
    }
    try {
      const prev = f.matches[f.cur]?.row;
      await this.loadText(f);
      if (seq !== f.seq || f !== this.find) return;
      f.matches = findMatches(f.text!, re);
      f.error = undefined;
      f.drift = 0;
      const v = f.view!;
      // Refining the query stays near the match it was on; a new search starts from the bottom of the view.
      f.cur = f.matches.length ? startAt(f.matches, prev ?? v.max_offset_from_bottom - v.offset_from_bottom + v.viewport_rows - 1) : -1;
      if (f.cur >= 0) await this.jump(f, f.cur);
      else this.paintFind();
    } catch (e) {
      if (f !== this.find) return;
      f.error = e instanceof Error ? e.message : String(e);
      this.paintFind();
    }
  }

  /** Next (newer, +1) or previous (older, -1) match, wrapping around. */
  private step(dir: 1 | -1) {
    const f = this.find;
    if (!f) return;
    if (!f.matches.length) return f.query ? this.searchSoon(0) : undefined;
    void this.jump(f, (f.cur + dir + f.matches.length) % f.matches.length).then(() => this.recheck(f));
  }

  /** After moving: if the pane's content changed since it was read, search again (rows may have moved). */
  private async recheck(f: FindState) {
    try {
      const rev = (await this.request<{ content_revision: number }>('pane.copy_motion', { cursor: { row: 0, col: 0 }, motion: 'line_end' })).content_revision;
      if (f === this.find && f.text && f.text.revision !== rev) await this.search(f);
    } catch {
      // stays on what it has
    }
  }

  /** Scroll Herdr's view so match `i` is in the middle, and highlight it. */
  private async jump(f: FindState, i: number) {
    const m = f.matches[i];
    if (!m || !f.view) return;
    f.cur = i;
    let v = await this.scrollTo(f, offsetFor(m.row, f.view.max_offset_from_bottom, f.view.viewport_rows));
    // New output since the history was read moves the bottom: aim again from where it is now.
    const again = v && offsetFor(m.row, v.max_offset_from_bottom, v.viewport_rows);
    if (v && again !== v.offset_from_bottom) v = await this.scrollTo(f, again!);
    f.verify = 5;
  }

  private async scrollTo(f: FindState, offset: number): Promise<PaneScroll | undefined> {
    try {
      // Not sent if the bar closed while it waited.
      const r = await this.inOrder(() => (f === this.find ? this.request<{ pane: { scroll?: PaneScroll } }>('pane.scroll', { offset_from_bottom: offset }) : undefined));
      if (!r || f !== this.find) return;
      if (r.pane.scroll) f.view = r.pane.scroll;
      if (f.view && f.view.offset_from_bottom > 0) this.screen?.scrolledAway();
      else this.screen?.inputSent();
      this.paintFind();
      return f.view;
    } catch (e) {
      if (f !== this.find) return;
      f.error = e instanceof Error ? e.message : String(e);
      this.paintFind();
    }
  }

  /** Highlight the matches on screen and draw the bar. */
  private paintFind() {
    const f = this.find;
    const screen = this.screen;
    if (!f || !screen) return;
    if (f.verify) this.verifyCurrent(f, screen);
    const marks: { y: number; from: number; to: number; current: boolean }[] = [];
    if (f.view && f.query) {
      const top = f.view.max_offset_from_bottom - f.view.offset_from_bottom - f.drift;
      const bottom = top + screen.rows;
      for (let i = 0; i < f.matches.length; i++) {
        const m = f.matches[i];
        if (m.row >= bottom) break;
        for (const s of m.spans) if (s.row >= top && s.row < bottom) marks.push({ y: s.row - top, from: s.from, to: s.to, current: i === f.cur });
      }
    }
    screen.setMarks(marks);
    const rows = [...new Set([...f.painted, ...marks.map((m) => m.y), ...screen.rowsOf(), 0])];
    f.painted = marks.map((m) => m.y);
    const info = f.error ?? (!f.query ? '' : f.matches.length ? `${f.cur + 1} of ${f.matches.length}` : 'No results');
    this.writer.fire(screen.paint(rows) + screen.findBar(f.query, info, '↑↓ ↵ · Tab list · Esc', !!f.error));
  }

  /**
   * Lines are mapped to rows by wrapping them at the pane's width; if that's off (a character's width), find the
   * current match on the screen near where it should be and correct for it.
   */
  private verifyCurrent(f: FindState, screen: Screen) {
    const m = f.matches[f.cur];
    if (!m || !f.view || !f.text) return void (f.verify = 0);
    f.verify--;
    const top = f.view.max_offset_from_bottom - f.view.offset_from_bottom - f.drift;
    const want = f.text.lines[m.line].substr(m.index, m.length).toLowerCase();
    const y = m.row - top;
    for (const d of [0, -1, 1, -2, 2, -3, 3]) {
      if (y + d < 0 || y + d >= screen.rows) continue;
      if (screen.rowText(y + d).text.toLowerCase().includes(want)) {
        f.drift += d;
        f.verify = 0;
        return;
      }
    }
  }

  /** Tab in the find bar: every match in a list; moving through it previews, Enter stays there. */
  private async listMatches() {
    const f = this.find;
    if (!f?.text || !f.matches.length) return;
    type Item = vscode.QuickPickItem & { i: number };
    const items: Item[] = f.matches.slice(0, LIST_MAX).map((m, i) => ({
      label: f.text!.lines[m.line].trim().slice(0, 200) || ' ',
      description: `row ${m.row + 1}`,
      i,
    }));
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `${f.matches.length} match${f.matches.length === 1 ? '' : 'es'} for “${f.query}”${f.matches.length > LIST_MAX ? ` (first ${LIST_MAX})` : ''}`;
    qp.placeholder = 'Type to filter the matching lines; Enter goes there';
    qp.items = items;
    const start = items[Math.min(f.cur, items.length - 1)];
    if (start) qp.activeItems = [start];
    let ready = false;
    qp.onDidChangeActive(([it]) => {
      if (ready && it && f === this.find) void this.jump(f, it.i);
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
      const f: { text?: PaneText; view?: PaneScroll } = {};
      await this.loadText(f);
      const doc = await vscode.workspace.openTextDocument({ content: f.text!.lines.join('\n').replace(/\s+$/, '') + '\n', language: 'log' });
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      const end = new vscode.Position(doc.lineCount - 1, 0);
      ed.selection = new vscode.Selection(end, end);
      ed.revealRange(new vscode.Range(end, end));
    } catch (e) {
      void vscode.window.showWarningMessage(`Couldn't read this pane's output from Herdr: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Read-only: selecting and copying still work; typing takes control back (the keystroke isn't sent). */
  private observeInput(screen: Screen, data: string) {
    for (const t of parseInput(data)) {
      if (t.kind === 'data') return this.takeBack();
      if (t.button !== 0 || t.wheel) continue; // the wheel scrolls Herdr's scrollback: only a controller can
      const r = screen.mouse(t);
      if (r.repaint.length) this.writer.fire(screen.paint(r.repaint) + (r.repaint.includes(screen.rows - 1) ? this.note() : ''));
      if (r.copy) this.copied(r.copy);
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
    clearTimeout(this.find?.timer);
    this.find = undefined;
    clearTimeout(this.scrollWait);
    clearTimeout(this.toastTimer);
    clearTimeout(this.resizeTimer);
    if (this.mode === 'control' && this.paneId) this.deps.unclaim?.(this.paneId);
    this.stream?.release();
    this.screen?.dispose();
  }

  private onStreamClosed(reason?: string, error?: string) {
    if (this.closedByUser) return;
    this.stopAutoScroll();
    if (this.mode === 'control' && this.paneId) {
      this.deps.unclaim?.(this.paneId);
      if (isTakenOver(reason)) return this.lostControl(this.paneId);
    }
    this.ended = true;
    const why = error ? `couldn't stream this pane: ${error}` : reason === 'detached' ? 'detached' : `the stream ended (${reason ?? 'closed'})`;
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
