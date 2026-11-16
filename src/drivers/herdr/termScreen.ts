// The screen behind a built-in Herdr terminal tab: a headless xterm fed with Herdr's frames, the mouse
// selection on it, and what to paint to show the selection. No vscode imports.
//
// Herdr's direct attach captures the mouse and drops drags for programs that don't use it, so nothing can be
// selected (see CLAUDE.md). Here the tab reports the mouse to us instead (SGR mode), and we do what the Herdr
// TUI does: drag, double-click (word) or triple-click (line) selects, release copies, the wheel scrolls.
// Beyond the TUI: a drag held on the top or bottom row scrolls Herdr's scrollback and keeps selecting, and
// Backspace / Delete deletes a selection on the line being typed.
import { Terminal } from '@xterm/headless';
import type { IBufferCell, IBufferLine } from '@xterm/headless';

const ESC = '\x1b';

/**
 * Written to the tab (and the model) before Herdr's first frame: the alternate screen (frames repaint the
 * screen, so they'd only litter the editor's scrollback), button-event mouse tracking with SGR coordinates
 * (drags and the wheel come to us), and bracketed paste (pastes arrive marked; shells and agents expect it).
 */
export const PRELUDE = `${ESC}[?1049h${ESC}[?1002h${ESC}[?1006h${ESC}[?2004h`;
/** Undo the prelude when the tab closes. */
export const POSTLUDE = `${ESC}[?2004l${ESC}[?1006l${ESC}[?1002l${ESC}[?1049l`;

// ---------- input: keystrokes and mouse reports ----------

export type InputToken =
  | { kind: 'data'; text: string }
  | { kind: 'mouse'; button: number; x: number; y: number; release: boolean; motion: boolean; wheel?: 'up' | 'down'; shift: boolean; alt: boolean; ctrl: boolean };

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Split what the tab sends into plain input and SGR mouse reports (cells 0-based). */
export function parseInput(data: string): InputToken[] {
  const out: InputToken[] = [];
  let last = 0;
  for (const m of data.matchAll(SGR_MOUSE)) {
    if (m.index! > last) out.push({ kind: 'data', text: data.slice(last, m.index) });
    const b = Number(m[1]);
    const wheel = b & 64 ? ((b & 1) === 0 ? 'up' : 'down') : undefined;
    out.push({
      kind: 'mouse',
      button: b & 3,
      x: Number(m[2]) - 1,
      y: Number(m[3]) - 1,
      release: m[4] === 'm',
      motion: !!(b & 32),
      ...(wheel && { wheel }),
      shift: !!(b & 4),
      alt: !!(b & 8),
      ctrl: !!(b & 16),
    } as InputToken);
    last = m.index! + m[0].length;
  }
  if (last < data.length) out.push({ kind: 'data', text: data.slice(last) });
  return out;
}

// ---------- the screen ----------

export interface Cell {
  x: number;
  y: number;
}

/**
 * A selection end: a column and a content row. Row `r` shows at `y = r + offset` while the view scrolls back
 * `offset` lines, so a selection stays on its text when Herdr scrolls (dragging past the top or bottom edge).
 */
export interface Pos {
  x: number;
  r: number;
}

/** Characters that end a word for double-click selection (like most terminals). */
const WORD_BREAK = /[\s()[\]{}<>'"`|│,;]/;

export type ScrollDir = 'up' | 'down';

/** A find match on screen (a viewport row), drawn highlighted; `current` is the one the find bar is on. */
export interface Mark {
  y: number;
  from: number;
  to: number;
  current: boolean;
}

/**
 * A selected row kept while it's out of view: its text when every cell is one UTF-16 unit (most rows), else one
 * string per cell (wide characters leave an empty cell, emoji take two units).
 */
interface KeptRow {
  text: string;
  cells?: string[];
  wrapped: boolean;
}

/**
 * Selected rows kept at most: a drag held on an edge scrolls up to 200 rows a second. Past it, rows newly scrolled
 * into the selection aren't kept (and aren't copied); the rows kept first, from the anchor along the drag, stay.
 */
const KEPT_MAX = 10_000;

/** Keys that delete the selection when it's on the line being typed. */
export const isDeleteKey = (text: string) => text === '\x7f' || text === '\b' || text === `${ESC}[3~`;

export class Screen {
  readonly term: Terminal;
  private anchor?: Pos;
  private head?: Pos;
  private selecting = false;
  /** The pointer's row while selecting, to keep the head under it when the view scrolls. */
  private headY?: number;
  private lastClick = { at: 0, x: -1, y: -1, count: 0 };
  /** Lines the view scrolled back since the selection started (negative: forward). */
  private offset = 0;
  /** The selected rows by content row, kept while they scroll out of view (at most KEPT_MAX). */
  private kept = new Map<number, KeptRow>();
  /** A scroll sent to Herdr whose frame hasn't come: the rows before it, to see how far it moved. */
  private pending?: { dir: ScrollDir; lines: number; before: string[] };
  /** The view shows the live screen (not Herdr's scrollback), so the cursor is where the program put it. */
  private live = true;
  /** Find matches on screen by viewport row. */
  private marks = new Map<number, Mark[]>();

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
    this.term.write(PRELUDE);
  }

  /** Write a frame. Resolves with how many lines the view moved when it's the answer to a scroll. */
  write(data: Buffer | string): Promise<number | undefined> {
    return new Promise((r) =>
      this.term.write(data, () => {
        const moved = this.settle();
        // Selected rows a scroll brought into view. At offset 0 nothing scrolled away: selectionText() reads the
        // rows on screen when it's asked, so there's nothing to copy on every frame.
        if (this.offset !== 0) {
          this.keep();
        }
        r(moved);
      }),
    );
  }
  resize(cols: number, rows: number) {
    this.clearSelection();
    this.pending = undefined;
    this.term.resize(Math.max(1, cols), Math.max(1, rows));
  }
  dispose() {
    this.term.dispose();
  }

  get cols() {
    return this.term.cols;
  }
  get rows() {
    return this.term.rows;
  }
  private line(y: number): IBufferLine | undefined {
    const b = this.term.buffer.active;
    return b.getLine(b.viewportY + y);
  }
  private visibleText(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) out.push(this.line(y)?.translateToString(true) ?? '');
    return out;
  }

  // ----- scrolling (Herdr's scrollback) -----

  /** A scroll is about to be sent to Herdr. The next frame that matches it says how far the view moved. */
  scrollSent(dir: ScrollDir, lines: number) {
    // The selected rows as they are, before some of them leave the view.
    this.keep();
    this.pending = { dir, lines, before: this.visibleText() };
  }
  /** No frame came for the scroll: the view didn't move (the top of the scrollback, or the live screen). */
  scrollTimedOut(): number | undefined {
    if (!this.pending) return;
    if (this.pending.dir === 'down') this.live = true;
    this.pending = undefined;
    return 0;
  }
  /** The wheel scrolled Herdr's view (not tracked: it clears the selection). */
  wheel(dir: ScrollDir) {
    if (dir === 'up') this.live = false;
  }
  /** Herdr's view was moved elsewhere (find, Page Up, Top): the cursor row isn't on screen. */
  scrolledAway() {
    this.live = false;
  }

  // ----- find highlights -----

  setMarks(marks: Mark[]) {
    this.marks = new Map();
    for (const m of marks) {
      if (m.y < 0 || m.y >= this.rows) {
        continue;
      }
      const row = this.marks.get(m.y);
      if (row) {
        row.push(m);
      } else {
        this.marks.set(m.y, [m]);
      }
    }
  }
  /** The text of a row on screen, with the cell column of each UTF-16 index (to place find highlights). */
  rowText(y: number): { text: string; colOf: number[] } {
    const line = this.line(y);
    if (!line) return { text: '', colOf: [] };
    const cell = this.term.buffer.active.getNullCell();
    let text = '';
    const colOf: number[] = [];
    for (let x = 0; x < this.cols; x++) {
      const c = line.getCell(x, cell);
      if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) colOf.push(x);
      text += ch;
    }
    return { text, colOf };
  }
  allRows(): number[] {
    return [...Array(this.rows).keys()];
  }
  /**
   * The find bar over the right of the top row (like the editor's find widget). It only paints: repaint row 0 to
   * remove it.
   */
  findBar(query: string, info: string, hint: string, error = false): string {
    const avail = this.cols;
    let body = ` Find: ${query}▏ ${info} `;
    if ([...body].length + [...hint].length + 1 <= Math.min(avail, 90)) body += `${hint} `;
    const label = [...body].slice(-avail).join('');
    const col = Math.max(0, this.cols - [...label].length);
    const color = error ? '0;1;37;41' : '0;30;47';
    return `${ESC}[?2026h${ESC}7${ESC}[1;${col + 1}H${ESC}[${color}m${label}${ESC}[0m${ESC}8${ESC}[?2026l`;
  }
  /** Input went to the program: Herdr shows the live screen again. */
  inputSent() {
    this.live = true;
    this.pending = undefined;
  }

  /**
   * The frame just written: the pending scroll's answer if the rows moved. The shift is the one most non-blank rows
   * agree with, and must beat "didn't move": a full-screen program (less, an agent's own transcript) gets the
   * scroll from Herdr instead of the scrollback, moves by its own step and keeps its header / footer rows fixed.
   * Another frame (a spinner) keeps it waiting.
   */
  private settle(): number | undefined {
    const p = this.pending;
    if (!p) return;
    const now = this.visibleText();
    const n = this.rows;
    const score = (k: number) => {
      let same = 0;
      for (let y = 0; y + k < n; y++) {
        const [a, b] = p.dir === 'up' ? [now[y + k], p.before[y]] : [now[y], p.before[y + k]];
        if (a && a === b) same++;
      }
      return same;
    };
    let best = 0;
    let bestScore = score(0);
    for (let k = 1; k < n; k++) {
      const s = score(k);
      if (s > bestScore || (s === bestScore && best > 0 && Math.abs(k - p.lines) < Math.abs(best - p.lines))) [best, bestScore] = [k, s];
    }
    if (!best) return undefined; // not the scroll's frame: keep waiting
    this.pending = undefined;
    this.offset += p.dir === 'up' ? best : -best;
    if (p.dir === 'up') this.live = false;
    // The pointer is still where it was (on the edge): the selection follows it into the new rows.
    if (this.selecting && this.head && this.headY !== undefined) this.head = { x: this.head.x, r: this.headY - this.offset };
    return best;
  }

  /** Where a drag at the edge should scroll: the pointer on the top / bottom row, coming from another row. */
  edge(): ScrollDir | undefined {
    if (!this.selecting || !this.anchor || !this.head || this.headY === undefined) return;
    const anchorY = this.anchor.r + this.offset;
    if (this.headY === 0 && anchorY !== 0) return 'up';
    if (this.headY === this.rows - 1 && anchorY !== this.rows - 1) return 'down';
  }

  // ----- selection -----

  hasSelection() {
    return !!this.anchor && !!this.head;
  }
  /** Normalized, inclusive: start <= end in reading order. */
  range(): { start: Pos; end: Pos } | undefined {
    if (!this.anchor || !this.head) return;
    const [a, b] = [this.anchor, this.head];
    return a.r < b.r || (a.r === b.r && a.x <= b.x) ? { start: a, end: b } : { start: b, end: a };
  }
  /** Rows on screen the selection covers (to repaint them). */
  rowsOf(): number[] {
    const r = this.range();
    if (!r) return [];
    const ys: number[] = [];
    for (let row = r.start.r; row <= r.end.r; row++) {
      const y = row + this.offset;
      if (y >= 0 && y < this.rows) ys.push(y);
    }
    return ys;
  }
  clearSelection(): number[] {
    const rows = this.rowsOf();
    this.anchor = this.head = this.headY = undefined;
    this.selecting = false;
    this.offset = 0;
    this.kept.clear();
    return rows;
  }
  private clamp(c: Cell): Cell {
    return { x: Math.min(Math.max(0, c.x), this.cols - 1), y: Math.min(Math.max(0, c.y), this.rows - 1) };
  }
  private cellsOf(line: IBufferLine): string[] {
    const cell = this.term.buffer.active.getNullCell();
    const out: string[] = [];
    for (let x = 0; x < this.cols; x++) {
      const c = line.getCell(x, cell);
      out.push(!c ? ' ' : c.getWidth() === 0 ? '' : c.getChars() || ' ');
    }
    return out;
  }
  private keptRow(line: IBufferLine): KeptRow {
    const cells = this.cellsOf(line);
    if (cells.every((c) => c.length === 1)) {
      return { text: cells.join(''), wrapped: line.isWrapped };
    }
    return { text: '', cells, wrapped: line.isWrapped };
  }
  /**
   * Remember the selected rows on screen, for when they scroll out of view. Once the view has scrolled, a row keeps
   * the text it had when first seen: a full-screen program's fixed footer would otherwise overwrite the rows that
   * slide under it.
   */
  private keep() {
    for (const y of this.rowsOf()) {
      const r = y - this.offset;
      const known = this.kept.has(r);
      if ((known && this.offset !== 0) || (!known && this.kept.size >= KEPT_MAX)) {
        continue;
      }
      const line = this.line(y);
      if (line) {
        this.kept.set(r, this.keptRow(line));
      }
    }
  }

  /** The selected text: rows joined by newlines (not inside a wrapped line), trailing spaces trimmed. */
  selectionText(): string {
    const r = this.range();
    if (!r) return '';
    this.keep();
    let out = '';
    for (let row = r.start.r; row <= r.end.r; row++) {
      const line = this.kept.get(row);
      if (!line) continue;
      const from = row === r.start.r ? r.start.x : 0;
      const to = row === r.end.r ? r.end.x + 1 : this.cols;
      if (row > r.start.r && !line.wrapped) out += '\n';
      let seg: string;
      if (line.cells) {
        seg = line.cells.slice(from, to).join('');
      } else {
        seg = line.text.slice(from, to);
      }
      // Trailing spaces are padding, except before the continuation of a wrapped line.
      out += row < r.end.r && this.kept.get(row + 1)?.wrapped ? seg : seg.replace(/[ \t]+$/, '');
    }
    return out;
  }

  /**
   * The keys that delete the selection, when it's on the line being typed (the cursor's row, live screen):
   * move the cursor to the selection's end, then one Backspace per character. Shells and agents (Claude Code,
   * Codex) keep the real cursor in their input. Undefined when that can't be done safely.
   */
  deleteKeys(): string | undefined {
    const r = this.range();
    if (!r || this.selecting || !this.live || this.pending || r.start.r !== r.end.r) return;
    const y = r.start.r + this.offset;
    const b = this.term.buffer.active;
    const line = this.line(y);
    if (!line || y !== b.cursorY) return;
    const cell = b.getNullCell();
    const width = (x: number) => (x < this.cols ? (line.getCell(x, cell)?.getWidth() ?? 1) : 1);
    let lastText = -1;
    for (let x = 0; x < this.cols; x++) if ((line.getCell(x, cell)?.getChars() ?? '').trim()) lastText = x;
    const cx = b.cursorX;
    let start = r.start.x;
    if (start > 0 && width(start) === 0) start--; // half of a wide character: all of it
    // Past the end of the input is only padding.
    const end = Math.min(r.end.x, Math.max(lastText, cx - 1));
    if (end < start) return;
    let after = end + 1;
    if (width(after) === 0) after++;
    const chars = (from: number, to: number) => {
      let n = 0;
      for (let x = from; x < to; x++) if (width(x) > 0) n++;
      return n;
    };
    const right = after > cx ? chars(cx, after) : 0;
    const left = after < cx ? chars(after, cx) : 0;
    const back = chars(start, after);
    if (!back) return;
    return `${ESC}[C`.repeat(right) + `${ESC}[D`.repeat(left) + '\x7f'.repeat(back);
  }

  /**
   * The arrow keys that move the cursor to a clicked cell on its own row (Option+click, like the editor's
   * terminal): live screen only, and not past the end of the input.
   */
  moveKeys(x: number, y: number): string | undefined {
    const b = this.term.buffer.active;
    const line = this.line(y);
    if (!this.live || this.pending || !line || y !== b.cursorY) return;
    const cell = b.getNullCell();
    const width = (i: number) => line.getCell(i, cell)?.getWidth() ?? 1;
    let lastText = -1;
    for (let i = 0; i < this.cols; i++) if ((line.getCell(i, cell)?.getChars() ?? '').trim()) lastText = i;
    const cx = b.cursorX;
    let to = Math.min(Math.max(0, x), Math.max(lastText + 1, cx));
    if (to > 0 && to < this.cols && width(to) === 0) to--;
    let n = 0;
    for (let i = Math.min(to, cx); i < Math.max(to, cx); i++) if (width(i) > 0) n++;
    if (!n) return;
    return (to > cx ? `${ESC}[C` : `${ESC}[D`).repeat(n);
  }

  private wordAt(c: Cell): { start: Pos; end: Pos } {
    const line = this.line(c.y);
    const text = line ? line.translateToString(false) : '';
    const ch = (i: number) => text[i] ?? ' ';
    const r = c.y - this.offset;
    if (WORD_BREAK.test(ch(c.x))) return { start: { x: c.x, r }, end: { x: c.x, r } };
    let s = c.x;
    let e = c.x;
    while (s > 0 && !WORD_BREAK.test(ch(s - 1))) s--;
    while (e < this.cols - 1 && !WORD_BREAK.test(ch(e + 1))) e++;
    return { start: { x: s, r }, end: { x: e, r } };
  }

  /**
   * A left-button mouse event. Returns what changed: rows to repaint, and the text to copy when a selection
   * is finished (release after a drag, or a double/triple click).
   */
  mouse(ev: { x: number; y: number; release: boolean; motion: boolean; shift?: boolean }, now = Date.now()): { repaint: number[]; copy?: string } {
    const c = this.clamp(ev);
    if (!ev.release && !ev.motion && ev.shift && this.anchor && this.head && !this.selecting) {
      // Shift+click: extend the selection to here (and keep dragging it).
      const before = this.rowsOf();
      this.head = { x: c.x, r: c.y - this.offset };
      this.headY = c.y;
      this.selecting = true;
      this.keep();
      return { repaint: [...new Set([...before, ...this.rowsOf()])] };
    }
    if (!ev.release && !ev.motion) {
      // press: click counting for word / line selection
      const same = now - this.lastClick.at < 400 && this.lastClick.x === c.x && this.lastClick.y === c.y;
      this.lastClick = { at: now, x: c.x, y: c.y, count: same ? this.lastClick.count + 1 : 1 };
      const before = this.clearSelection();
      if (this.lastClick.count === 2 || this.lastClick.count >= 3) {
        const w = this.lastClick.count === 2 ? this.wordAt(c) : { start: { x: 0, r: c.y }, end: { x: this.cols - 1, r: c.y } };
        this.anchor = w.start;
        this.head = w.end;
        const text = this.selectionText();
        return { repaint: [...new Set([...before, ...this.rowsOf()])], copy: text || undefined };
      }
      this.anchor = { x: c.x, r: c.y };
      this.head = undefined; // a plain click selects nothing until the mouse moves
      this.selecting = true;
      this.headY = c.y;
      return { repaint: before };
    }
    if (ev.motion && this.selecting && this.anchor) {
      const before = this.rowsOf();
      this.head = { x: c.x, r: c.y - this.offset };
      this.headY = c.y;
      this.keep();
      return { repaint: [...new Set([...before, ...this.rowsOf()])] };
    }
    if (ev.release && this.selecting) {
      this.selecting = false;
      this.headY = undefined;
      if (!this.head) {
        this.anchor = undefined;
        return { repaint: [] };
      }
      const text = this.selectionText();
      return { repaint: [], copy: text || undefined };
    }
    return { repaint: [] };
  }

  // ----- painting -----

  /** The selected columns of screen row `y`, inclusive (`from > to`: none). */
  private selectedSpan(sel: { start: Pos; end: Pos } | undefined, y: number): { from: number; to: number } {
    const row = y - this.offset;
    if (!sel || row < sel.start.r || row > sel.end.r) {
      return { from: 1, to: 0 };
    }
    let from = 0;
    let to = this.cols - 1;
    if (row === sel.start.r) {
      from = sel.start.x;
    }
    if (row === sel.end.r) {
      to = sel.end.x;
    }
    return { from, to };
  }

  /**
   * A short message over the middle of the bottom row, like the Herdr TUI's "copied" toast: green (`ok`), or
   * yellow (`note`, e.g. "Kiro is using this pane"). It only paints: repaint `row` (paint([row])) to remove it.
   */
  toast(text: string, tone: 'ok' | 'note' = 'ok'): { row: number; paint: string } {
    const row = this.rows - 1;
    const label = [...` ${text} `].slice(0, this.cols).join('');
    const col = Math.max(0, Math.floor((this.cols - [...label].length) / 2));
    const color = tone === 'ok' ? '42' : '43';
    return { row, paint: `${ESC}[?2026h${ESC}7${ESC}[${row + 1};${col + 1}H${ESC}[0;1;30;${color}m${label}${ESC}[0m${ESC}8${ESC}[?2026l` };
  }

  /** Repaint rows from the model, with the selection shown inverted; ends with the cursor back in place. */
  paint(rows: number[]): string {
    if (!rows.length) return '';
    let out = `${ESC}[?2026h${ESC}7`;
    const cell = this.term.buffer.active.getNullCell();
    // Worked out once per paint and per row, not per cell: a frame repaints every selected row.
    const sel = this.range();
    for (const y of rows) {
      const line = this.line(y);
      if (!line || y < 0 || y >= this.rows) {
        continue;
      }
      const { from, to } = this.selectedSpan(sel, y);
      const marks = this.marks.get(y);
      out += `${ESC}[${y + 1};1H`;
      let sgr = '';
      for (let x = 0; x < this.cols; x++) {
        const c = line.getCell(x, cell);
        if (!c || c.getWidth() === 0) {
          continue;
        }
        let mark: 'match' | 'current' | undefined;
        if (marks) {
          mark = markAt(marks, x);
        }
        const s = sgrOf(c, x >= from && x <= to, mark);
        if (s !== sgr) {
          out += `${ESC}[${s}m`;
          sgr = s;
        }
        out += c.getChars() || ' ';
      }
      out += `${ESC}[0m`;
    }
    return out + `${ESC}8${ESC}[?2026l`;
  }
}

/** The find highlight on column `x` of a row with these marks: the current match wins over the others. */
function markAt(marks: Mark[], x: number): 'match' | 'current' | undefined {
  let hit: 'match' | 'current' | undefined;
  for (const m of marks) {
    if (x < m.from || x >= m.to) {
      continue;
    }
    if (m.current) {
      return 'current';
    }
    hit = 'match';
  }
  return hit;
}

/** SGR parameters for a cell (starting from a reset), inverted when selected, highlighted for a find match. */
function sgrOf(c: IBufferCell, selected: boolean, mark?: 'match' | 'current'): string {
  if (mark && !selected) return mark === 'current' ? '0;1;30;48;5;208' : '0;30;43';
  const p = ['0'];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isBlink()) p.push('5');
  if (!!c.isInverse() !== selected) p.push('7');
  if (c.isInvisible()) p.push('8');
  if (c.isStrikethrough()) p.push('9');
  const color = (rgb: boolean, palette: boolean, v: number, base: number, bright: number, ext: number) => {
    if (rgb) p.push(`${ext};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
    else if (palette) p.push(v < 8 ? String(base + v) : v < 16 ? String(bright + v - 8) : `${ext};5;${v}`);
  };
  color(c.isFgRGB(), c.isFgPalette(), c.getFgColor(), 30, 90, 38);
  color(c.isBgRGB(), c.isBgPalette(), c.getBgColor(), 40, 100, 48);
  return p.join(';');
}
