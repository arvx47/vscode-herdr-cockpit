// Searching a pane's whole history (Herdr's scrollback), for the find bar of a built-in Herdr tab.
// No vscode imports.
//
// The tab only holds the screen. Herdr has the history (verified on 0.9.3):
//  - `pane.get` → `scroll {offset_from_bottom, max_offset_from_bottom, viewport_rows}`: the history has
//    `max_offset_from_bottom + viewport_rows` screen rows, row 0 the oldest.
//  - `pane.selection.read {anchor, cursor}` returns the text between two points (columns must be < the pane's
//    width), one line per logical line: a soft-wrapped line comes back joined, so lines are mapped back to rows
//    by wrapping them at the pane's width (`layout`, which keeps only where each line wraps). ~100ms for 3,000 rows.
//  - `pane.scroll {offset_from_bottom}` scrolls the view there (the top row is then `max - offset`).
//  - `pane.copy_motion` with no revision answers the current `content_revision` (it changes with the content).
//  - Herdr's own `pane.copy_search` is literal and case-sensitive, and returns at most 1024 matches, so the
//    search itself runs here: smart case, `/regex/`, every match counted.

/** Display width of a character in terminal cells (0 for combining marks, 2 for wide CJK and emoji). */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x300) return c < 0x20 ? 0 : 1;
  if ((c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f) || /^\p{M}$/u.test(ch)) return 0; // zero width, combining
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x1fa70 && c <= 0x1faff) ||
    (c >= 0x1f680 && c <= 0x1f6ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
    return 2;
  return 1;
}

/**
 * Where each character of a line lands when it's wrapped at `cols`: `at(index)` gives the row offset and column of
 * a UTF-16 index (past the end: where the line ends). Only the index each row starts at is stored, and `at` walks
 * that one row: a whole history is laid out, and a position per character cost more memory than the text.
 */
export function layout(line: string, cols: number): { rows: number; at: (index: number) => { row: number; col: number } } {
  const starts = [0];
  let col = 0;
  for (let i = 0; i < line.length; ) {
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = charWidth(ch);
    if (w > 0 && col + w > cols) {
      starts.push(i);
      col = 0;
    }
    col += w;
    i += ch.length;
  }
  /** The column of `index` on `row` (the row's end when `index` is past it). */
  const colOn = (row: number, index: number) => {
    let c = 0;
    for (let i = starts[row]; i < line.length; ) {
      const ch = String.fromCodePoint(line.codePointAt(i)!);
      if (index < i + ch.length) {
        return c;
      }
      c += charWidth(ch);
      i += ch.length;
    }
    return c;
  };
  const at = (index: number) => {
    const last = starts.length - 1;
    if (!(index >= 0 && index < line.length)) {
      return { row: last, col: colOn(last, line.length) };
    }
    // The last row starting at or before it (a wide character that can't fit even an empty row starts two).
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { row: lo, col: colOn(lo, index) };
  };
  return { rows: starts.length, at };
}

/** A pane's history as text, with the screen row each line starts on. */
export class PaneText {
  readonly starts: number[] = [];
  readonly layouts: ReturnType<typeof layout>[] = [];
  constructor(
    readonly lines: string[],
    readonly cols: number,
    /** The content revision it was read at. */
    readonly revision?: number,
  ) {
    let row = 0;
    for (const l of lines) {
      const lay = layout(l, cols);
      this.starts.push(row);
      this.layouts.push(lay);
      row += lay.rows;
    }
  }
}

/** A match: its line and range in it, and the screen cells it covers (one span per row it's on). */
export interface Match {
  line: number;
  index: number;
  length: number;
  /** The row it starts on (0 = the oldest row of the history). */
  row: number;
  spans: { row: number; from: number; to: number }[];
}

/**
 * The query as a regular expression: `/…/` (optionally `/…/i`) is a regex, anything else literal; smart case
 * (case-insensitive unless the query has a capital letter). Undefined for an empty query; an Error for a bad regex.
 */
export function compileQuery(q: string): RegExp | Error | undefined {
  if (!q) return;
  const re = /^\/(.+)\/([a-z]*)$/.exec(q);
  const source = re ? re[1] : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = re ? re[2] : '';
  const letters = re ? source.replace(/\\./g, '') : q; // `\S`, `\W` aren't capitals
  const caseless = flags.includes('i') || letters === letters.toLowerCase();
  try {
    return new RegExp(source, `g${caseless ? 'i' : ''}${flags.replace(/[^msu]/g, '')}`);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** Every match of `re` in the text, oldest first (at most `limit`). Empty matches are skipped. */
export function findMatches(text: PaneText, re: RegExp, limit = 100_000): Match[] {
  const out: Match[] = [];
  for (let i = 0; i < text.lines.length && out.length < limit; i++) {
    const line = text.lines[i];
    re.lastIndex = 0;
    for (let m = re.exec(line); m && out.length < limit; m = re.exec(line)) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      const lay = text.layouts[i];
      const a = lay.at(m.index);
      const b = lay.at(m.index + m[0].length - 1);
      const lastWidth = charWidth(String.fromCodePoint(line.codePointAt(m.index + m[0].length - 1) ?? 32)) || 1;
      const spans: Match['spans'] = [];
      for (let r = a.row; r <= b.row; r++)
        spans.push({ row: text.starts[i] + r, from: r === a.row ? a.col : 0, to: r === b.row ? b.col + lastWidth : text.cols });
      out.push({ line: i, index: m.index, length: m[0].length, row: text.starts[i] + a.row, spans });
    }
  }
  return out;
}

/** The scroll position (`offset_from_bottom`) that puts `row` in the middle of the view. */
export function offsetFor(row: number, maxOffset: number, viewportRows: number): number {
  const top = row - Math.floor((viewportRows - 1) / 2);
  return Math.min(maxOffset, Math.max(0, maxOffset - top));
}

/** The match to start at: the last one above the bottom of the view (the newest, when at the live screen). */
export function startAt(matches: Match[], viewBottomRow: number): number {
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].row <= viewBottomRow) return i;
  return matches.length - 1;
}
