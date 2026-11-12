// The find bar of a built-in Herdr tab (⌘F): searching the pane's whole history (termFind.ts) and moving Herdr's
// view to the matches. No vscode imports: the tab (builtinTerminal.ts) gives it its screen, socket requests for
// its pane and a way to write to the tab, keeps the mouse for itself and shows the list of matches (Tab).
import { errorText } from './herdrClient';
import { compileQuery, findMatches, Match, offsetFor, PaneText, startAt } from './termFind';
import type { Mark, Screen } from './termScreen';

export interface PaneScroll {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface FindDeps {
  /** The tab's screen (undefined until the tab opens). */
  screen(): Screen | undefined;
  /** A Herdr socket request about the tab's pane (its pane_id is added). */
  request<T = any>(method: string, params: object, timeoutMs?: number): Promise<T>;
  /** Write to the tab. */
  write(data: string): void;
  log(line: string): void;
  /** Tab in the find bar: show every match (see list()). */
  showList(): void;
}

/** What the list of matches shows, and how to go to one of them. */
export interface MatchList {
  query: string;
  total: number;
  /** The match the bar is on (an index into items, when it's listed). */
  current: number;
  items: { label: string; row: number }[];
  /** Go to item `i` (nothing once the bar closed or searched again). */
  jump(i: number): void;
}

/** Typing in the find bar: wait this long before searching. */
const FIND_DEBOUNCE_MS = 120;
/**
 * Moving between matches re-reads the history if the pane changed since it was read, but not more often than
 * this (holding Enter in a busy pane re-read all of it on every step). A new query always checks.
 */
const RECHECK_MS = 1000;

/** The find bar's state. Rows are the history's (0 = oldest); `view` is Herdr's view as last answered. */
export interface FindState {
  query: string;
  matches: Match[];
  /** Index into matches (oldest first), -1 for none. */
  cur: number;
  error?: string;
  text?: PaneText;
  /** When the text was last read or found current. */
  checkedAt: number;
  view?: PaneScroll;
  /** Rows the line wrapping guessed wrong by (corrected from the screen after a jump). */
  drift: number;
  /** Check the current match against the screen once its frame is in. */
  verify: number;
  /** Mark rows painted last (to clear them). */
  painted: number[];
  timer?: NodeJS.Timeout;
  recheckTimer?: NodeJS.Timeout;
  seq: number;
}

export class FindController {
  private find?: FindState;
  /**
   * Find moves Herdr's view with socket requests, keys and the wheel go through the stream: a jump still on its way
   * must land before input made after it (Esc, then typing or Bottom, was scrolled back to the match once).
   */
  private viewQueue: Promise<unknown> = Promise.resolve();
  private viewPending = 0;
  /** The last query, offered when the find bar opens again. */
  private lastQuery = '';

  constructor(private readonly deps: FindDeps) {}

  /** The find bar is open. */
  get active(): boolean {
    return !!this.find;
  }

  /** The open find bar's query, matches and current match (read by the editor test); undefined when closed. */
  get state(): Readonly<FindState> | undefined {
    return this.find;
  }

  /** Open the find bar (the tab checked it has control of the pane: searching scrolls Herdr's view). */
  open() {
    if (!this.find) {
      this.find = { query: this.lastQuery, matches: [], cur: -1, checkedAt: 0, drift: 0, verify: 0, painted: [], seq: 0 };
    }
    this.paint();
    if (this.find.query) {
      this.searchSoon(0);
    }
  }

  /** Close the find bar. The view stays where it is (typing returns to the live screen). */
  close() {
    const f = this.find;
    if (!f) {
      return;
    }
    this.stop(f);
    this.lastQuery = f.query;
    const screen = this.deps.screen();
    if (screen) {
      screen.setMarks([]);
      this.deps.write(screen.paint([...new Set([0, ...f.painted])]));
    }
  }

  /** The tab closed: stop, without painting. */
  dispose() {
    if (this.find) {
      this.stop(this.find);
    }
  }

  private stop(f: FindState) {
    clearTimeout(f.timer);
    clearTimeout(f.recheckTimer);
    this.find = undefined;
  }

  /** Run now, unless find's view changes are still on their way: then after them. */
  soon(fn: () => void) {
    if (this.viewPending) {
      void this.inOrder(fn);
    } else {
      fn();
    }
  }

  /** Queue a change of Herdr's view behind the ones still on their way. */
  private inOrder<T>(fn: () => T | Promise<T>): Promise<T> {
    this.viewPending++;
    const p = this.viewQueue.then(fn).finally(() => this.viewPending--);
    this.viewQueue = p.catch(() => undefined);
    return p;
  }

  /**
   * Keys typed while the bar is open (not mouse reports): they edit the query and move between matches.
   * Escape or Ctrl+C closes the bar, and what follows them is dropped (see `active`).
   */
  key(text: string) {
    const f = this.find;
    if (!f) {
      return;
    }
    let q = f.query;
    for (let i = 0; i < text.length; ) {
      const rest = text.slice(i);
      // eslint-disable-next-line no-control-regex -- an escape sequence (arrow keys)
      const arrow = /^\x1b(?:\[[0-9;?]*([A-Za-z~])|O([A-Za-z]))/.exec(rest);
      if (rest.startsWith('\x1b[200~')) {
        // A paste: its first line goes into the query.
        let end = rest.indexOf('\x1b[201~');
        if (end < 0) {
          end = rest.length;
        }
        q += rest.slice(6, end).split(/\r\n|\r|\n/)[0];
        i += Math.min(rest.length, end + 6);
      } else if (arrow) {
        const k = arrow[1] ?? arrow[2];
        if (k === 'A') {
          this.step(-1);
        } else if (k === 'B') {
          this.step(1);
        }
        i += arrow[0].length;
      } else if (rest[0] === '\x1b' && rest[1] === '\r') {
        this.step(1); // Option/Alt+Enter: newer
        i += 2;
      } else if (rest[0] === '\x1b' || rest[0] === '\x03') {
        this.close(); // Escape, Ctrl+C
        return;
      } else {
        const ch = String.fromCodePoint(rest.codePointAt(0)!);
        i += ch.length;
        if (ch === '\r') {
          this.step(-1); // Enter: older (upwards from the bottom, like the editor's terminal find)
        } else if (ch === '\t') {
          this.deps.showList();
        } else if (ch === '\x7f' || ch === '\b') {
          q = [...q].slice(0, -1).join('');
        } else if (ch === '\x15') {
          q = '';
        } else if (ch === '\x17') {
          q = q.replace(/\S*\s*$/, '');
        } else if (ch >= ' ') {
          q += ch;
        }
      }
    }
    if (q !== f.query) {
      f.query = q;
      this.paint();
      this.searchSoon(FIND_DEBOUNCE_MS);
    }
  }

  /** The wheel while the bar is open: scroll Herdr's view (and keep it known, the highlights are placed from it). */
  wheel(dir: 'up' | 'down', lines: number) {
    const f = this.find;
    const v = f?.view;
    if (!f || !v) {
      return;
    }
    let by = -lines;
    if (dir === 'up') {
      by = lines;
    }
    void this.scrollTo(f, Math.min(v.max_offset_from_bottom, Math.max(0, v.offset_from_bottom + by)));
  }

  /** Page Up / Page Down / Top / Bottom while the bar is open. False when it doesn't know the view yet. */
  scrollView(a: 'page-up' | 'page-down' | 'top' | 'bottom', page: number): boolean {
    const f = this.find;
    const v = f?.view;
    if (!f || !v) {
      return false;
    }
    let to = 0;
    if (a === 'top') {
      to = v.max_offset_from_bottom;
    } else if (a === 'page-up') {
      to = v.offset_from_bottom + page;
    } else if (a === 'page-down') {
      to = v.offset_from_bottom - page;
    }
    void this.scrollTo(f, Math.min(v.max_offset_from_bottom, Math.max(0, to)));
    return true;
  }

  private searchSoon(ms: number) {
    const f = this.find;
    if (!f) {
      return;
    }
    clearTimeout(f.timer);
    f.timer = setTimeout(() => void this.search(f), ms);
  }

  /** The pane's whole history as text (Open Output). */
  async readHistory(): Promise<PaneText> {
    const f: { text?: PaneText; view?: PaneScroll; checkedAt: number } = { checkedAt: 0 };
    await this.loadText(f);
    return f.text!;
  }

  /** Read the pane's history (again, when its content or the tab's width changed). */
  private async loadText(f: { text?: PaneText; view?: PaneScroll; checkedAt: number }): Promise<void> {
    const rev = (await this.deps.request<{ content_revision: number }>('pane.copy_motion', { cursor: { row: 0, col: 0 }, motion: 'line_end' })).content_revision;
    const view = (await this.deps.request<{ pane: { scroll?: PaneScroll } }>('pane.get', {})).pane.scroll;
    if (!view) {
      throw new Error('Herdr gave no scroll position for this pane');
    }
    f.view = view;
    const screen = this.deps.screen();
    if (!screen) {
      throw new Error('the tab is not open');
    }
    const cols = screen.cols;
    if (f.text && f.text.revision === rev && f.text.cols === cols) {
      f.checkedAt = Date.now();
      return;
    }
    const last = view.max_offset_from_bottom + view.viewport_rows - 1;
    const read = (col: number) => this.deps.request<{ text: string }>('pane.selection.read', { anchor: { row: 0, col: 0 }, cursor: { row: last, col } }, 30_000);
    const r = await read(cols - 1).catch(() => read(0)); // a narrower pane than the tab: drop the last row's tail
    f.text = new PaneText(r.text.split('\n'), cols, rev);
    f.checkedAt = Date.now();
  }

  private async search(f: FindState) {
    if (f !== this.find) {
      return;
    }
    const seq = ++f.seq;
    const re = compileQuery(f.query);
    if (!re || re instanceof Error) {
      f.matches = [];
      f.cur = -1;
      f.error = undefined;
      if (re instanceof Error) {
        f.error = 'Invalid regular expression';
      }
      return this.paint();
    }
    try {
      const prev = f.matches[f.cur]?.row;
      await this.loadText(f);
      if (seq !== f.seq || f !== this.find) {
        return;
      }
      f.matches = findMatches(f.text!, re);
      f.error = undefined;
      f.drift = 0;
      const v = f.view!;
      // Refining the query stays near the match it was on; a new search starts from the bottom of the view.
      f.cur = -1;
      if (f.matches.length) {
        f.cur = startAt(f.matches, prev ?? v.max_offset_from_bottom - v.offset_from_bottom + v.viewport_rows - 1);
      }
      if (f.cur >= 0) {
        await this.jump(f, f.cur);
      } else {
        this.paint();
      }
    } catch (e) {
      if (f !== this.find) {
        return;
      }
      f.error = errorText(e);
      this.paint();
    }
  }

  /** Next (newer, +1) or previous (older, -1) match, wrapping around. */
  step(dir: 1 | -1) {
    const f = this.find;
    if (!f) {
      return;
    }
    if (!f.matches.length) {
      if (f.query) {
        this.searchSoon(0);
      }
      return;
    }
    void this.jump(f, (f.cur + dir + f.matches.length) % f.matches.length).then(() => this.recheck(f));
  }

  /**
   * After moving: if the pane's content changed since it was read, search again (rows may have moved). Text
   * checked less than RECHECK_MS ago is kept, and looked at again once that has passed.
   */
  private async recheck(f: FindState) {
    if (f !== this.find || !f.text) {
      return;
    }
    const age = Date.now() - f.checkedAt;
    if (age < RECHECK_MS) {
      if (!f.recheckTimer) {
        f.recheckTimer = setTimeout(() => {
          f.recheckTimer = undefined;
          void this.recheck(f);
        }, RECHECK_MS - age);
      }
      return;
    }
    try {
      const rev = (await this.deps.request<{ content_revision: number }>('pane.copy_motion', { cursor: { row: 0, col: 0 }, motion: 'line_end' })).content_revision;
      if (f !== this.find || !f.text) {
        return;
      }
      if (f.text.revision !== rev || f.text.cols !== this.deps.screen()?.cols) {
        await this.search(f);
      } else {
        f.checkedAt = Date.now();
      }
    } catch (e) {
      // It stays on what it has.
      this.deps.log(`find: couldn't check the pane's content: ${errorText(e)}`);
    }
  }

  /** Scroll Herdr's view so match `i` is in the middle, and highlight it. */
  private async jump(f: FindState, i: number) {
    const m = f.matches[i];
    if (!m || !f.view) {
      return;
    }
    f.cur = i;
    let v = await this.scrollTo(f, offsetFor(m.row, f.view.max_offset_from_bottom, f.view.viewport_rows));
    // New output since the history was read moves the bottom: aim again from where it is now.
    if (v) {
      const again = offsetFor(m.row, v.max_offset_from_bottom, v.viewport_rows);
      if (again !== v.offset_from_bottom) {
        v = await this.scrollTo(f, again);
      }
    }
    f.verify = 5;
  }

  private async scrollTo(f: FindState, offset: number): Promise<PaneScroll | undefined> {
    try {
      // Not sent if the bar closed while it waited.
      const r = await this.inOrder(() => {
        if (f !== this.find) {
          return undefined;
        }
        return this.deps.request<{ pane: { scroll?: PaneScroll } }>('pane.scroll', { offset_from_bottom: offset });
      });
      if (!r || f !== this.find) {
        return;
      }
      if (r.pane.scroll) {
        f.view = r.pane.scroll;
      }
      const screen = this.deps.screen();
      if (f.view && f.view.offset_from_bottom > 0) {
        screen?.scrolledAway();
      } else {
        screen?.inputSent();
      }
      this.paint();
      return f.view;
    } catch (e) {
      if (f !== this.find) {
        return;
      }
      f.error = errorText(e);
      this.paint();
    }
  }

  /** Highlight the matches on screen and draw the bar (again, e.g. after a frame painted over them). */
  paint() {
    const f = this.find;
    const screen = this.deps.screen();
    if (!f || !screen) {
      return;
    }
    if (f.verify) {
      this.verifyCurrent(f, screen);
    }
    const marks: Mark[] = [];
    if (f.view && f.query) {
      const top = f.view.max_offset_from_bottom - f.view.offset_from_bottom - f.drift;
      const bottom = top + screen.rows;
      for (let i = 0; i < f.matches.length; i++) {
        const m = f.matches[i];
        if (m.row >= bottom) {
          break;
        }
        for (const s of m.spans) {
          if (s.row >= top && s.row < bottom) {
            marks.push({ y: s.row - top, from: s.from, to: s.to, current: i === f.cur });
          }
        }
      }
    }
    screen.setMarks(marks);
    const rows = [...new Set([...f.painted, ...marks.map((m) => m.y), ...screen.rowsOf(), 0])];
    f.painted = marks.map((m) => m.y);
    let info = '';
    if (f.error) {
      info = f.error;
    } else if (f.query && f.matches.length) {
      info = `${f.cur + 1} of ${f.matches.length}`;
    } else if (f.query) {
      info = 'No results';
    }
    this.deps.write(screen.paint(rows) + screen.findBar(f.query, info, '↑↓ ↵ · Tab list · Esc', !!f.error));
  }

  /**
   * Lines are mapped to rows by wrapping them at the pane's width; if that's off (a character's width), find the
   * current match on the screen near where it should be and correct for it.
   */
  private verifyCurrent(f: FindState, screen: Screen) {
    const m = f.matches[f.cur];
    if (!m || !f.view || !f.text) {
      f.verify = 0;
      return;
    }
    f.verify--;
    const top = f.view.max_offset_from_bottom - f.view.offset_from_bottom - f.drift;
    const want = f.text.lines[m.line].substr(m.index, m.length).toLowerCase();
    const y = m.row - top;
    for (const d of [0, -1, 1, -2, 2, -3, 3]) {
      if (y + d < 0 || y + d >= screen.rows) {
        continue;
      }
      if (screen.rowText(y + d).text.toLowerCase().includes(want)) {
        f.drift += d;
        f.verify = 0;
        return;
      }
    }
  }

  /** The matches for the list (Tab), at most `max` of them. Undefined without matches. */
  list(max: number): MatchList | undefined {
    const f = this.find;
    const text = f?.text;
    if (!f || !text || !f.matches.length) {
      return;
    }
    return {
      query: f.query,
      total: f.matches.length,
      current: f.cur,
      items: f.matches.slice(0, max).map((m) => ({ label: text.lines[m.line].trim().slice(0, 200), row: m.row })),
      jump: (i) => {
        if (f === this.find) {
          void this.jump(f, i);
        }
      },
    };
  }
}
