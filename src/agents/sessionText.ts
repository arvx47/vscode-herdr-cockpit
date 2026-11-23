// What a Claude Code session is about, for its sidebar row (herdr.agentDescription = request): the last message
// you typed to it, read from the session's transcript. Claude Code keeps one transcript per session in
// <config dir>/projects/<the folder, every character but letters and digits made "-">/<session id>.jsonl. Herdr
// doesn't say which session a pane runs (agent_session is empty), so a pane's transcript is the newest one in its
// folder whose session title (an `ai-title` record) is the pane's terminal title: Claude Code titles its terminal
// with it. Only the end of a transcript is read, and only again when it changed. No vscode imports
// (test/sessionTextTest.ts).
import * as fs from 'fs';
import * as path from 'path';

/** The transcripts looked at per folder: the most recently written ones. */
const MAX_FILES = 20;
/** How much of a transcript's end is read: first this, then up to TAIL_MAX when no message of yours is in it. */
const TAIL_FIRST = 256 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;
/** A request is cut to this many characters (the row shows one line, two when it's open). */
const MAX_CHARS = 300;

export function claudeProjectDir(configDir: string, cwd: string): string {
  return path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** A message you typed, from one transcript line; undefined for anything else (tool results, commands, Claude's turns). */
export function humanMessage(o: any): string | undefined {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) {
    return undefined;
  }
  // Newer Claude Code marks what a person typed; tool results and injected text have no origin or another kind.
  if (o.origin && o.origin.kind !== 'human') {
    return undefined;
  }
  const content = o.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (!o.origin && content.some((b: any) => b?.type === 'tool_result')) {
      return undefined;
    }
    text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  // Slash commands and their output come wrapped in tags (<command-name>, <local-command-stdout>).
  if (!text || text.startsWith('<')) {
    return undefined;
  }
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS - 1).trimEnd() + '…';
  }
  return text;
}

interface TailInfo {
  size: number;
  mtimeMs: number;
  title?: string;
  request?: string;
}

/** The session title and your last message in the lines of a transcript's end (the first may be cut: skipped). */
export function scanTail(text: string, fromStart: boolean): { title?: string; request?: string } {
  const lines = text.split('\n');
  if (!fromStart) {
    lines.shift();
  }
  let title: string | undefined;
  // A name you gave the session (/rename) wins over the titles Claude Code keeps writing after it.
  let custom: string | undefined;
  let request: string | undefined;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === 'ai-title' && typeof o.aiTitle === 'string') {
      title = o.aiTitle.trim();
    } else if (o?.type === 'custom-title' && typeof o.customTitle === 'string') {
      custom = o.customTitle.trim();
    } else {
      const msg = humanMessage(o);
      if (msg) {
        request = msg;
      }
    }
  }
  return { title: custom ?? title, request };
}

async function readTail(file: string, size: number, bytes: number): Promise<string> {
  const start = Math.max(0, size - bytes);
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** The last name you gave a session (/rename) in `text`'s whole lines: only lines naming it are parsed. */
export function lastCustomTitle(text: string): string | undefined {
  let custom: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('"custom-title"')) {
      continue;
    }
    try {
      const o = JSON.parse(line);
      if (o?.type === 'custom-title' && typeof o.customTitle === 'string') {
        custom = o.customTitle.trim();
      }
    } catch {
      // A line cut short or not JSON.
    }
  }
  return custom;
}

/** The terminal title of a Claude Code session that has none of its own yet. */
const DEFAULT_TITLE = 'Claude Code';

/** A project folder's listing is reused this long: the poll runs every 4s, so each folder is listed once per poll. */
const LISTING_MS = 3000;

/** How much of a transcript is read at once when looking for its /rename name. */
const CUSTOM_CHUNK = 1024 * 1024;
/** At most this much read for /rename names per poll (all its find() calls share one); the rest on the next polls. */
const CUSTOM_BUDGET = 16 * 1024 * 1024;

/** What a poll may still read looking for /rename names, and the buffer it reads into. */
export interface ReadBudget {
  bytes: number;
  buf?: Buffer;
}

/** A fresh budget: one per poll, passed to each find() of it. */
export function readBudget(): ReadBudget {
  return { bytes: CUSTOM_BUDGET };
}

export class SessionRequests {
  /** `listingMs`: how long a folder's listing is reused (tests that add files at once pass 0). */
  constructor(private readonly listingMs = LISTING_MS) {}

  private cache = new Map<string, TailInfo>();
  /**
   * Each transcript's /rename name, from the whole file: it can sit far before the end (one was 1.4MB back). The
   * file is read once, then only what was added since (`offset`, at a line's start).
   */
  private customs = new Map<string, { offset: number; title?: string }>();

  /** Each project folder's transcripts, listed once per poll however many panes work in it (LISTING_MS). */
  private listings = new Map<string, { at: number; files: Promise<{ file: string; st: fs.Stats }[]> }>();

  private listing(project: string): Promise<{ file: string; st: fs.Stats }[]> {
    const old = this.listings.get(project);
    if (old && Date.now() - old.at < this.listingMs) {
      return old.files;
    }
    const files = (async () => {
      const found: { file: string; st: fs.Stats }[] = [];
      let names: string[];
      try {
        names = await fs.promises.readdir(project);
      } catch {
        return found;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) {
          continue;
        }
        const file = path.join(project, name);
        try {
          found.push({ file, st: await fs.promises.stat(file) });
        } catch {
          // Removed meanwhile.
        }
      }
      return found;
    })();
    this.listings.set(project, { at: Date.now(), files });
    return files;
  }

  /**
   * `budget.bytes`: how much this find() may still read for /rename names; what's left of a file is read on the next
   * polls (the offset is kept), so a folder of big transcripts costs a bounded amount per poll.
   */
  private async customTitle(file: string, size: number, budget: ReadBudget): Promise<{ title?: string; done: boolean }> {
    let known = this.customs.get(file);
    if (!known || known.offset > size) {
      known = { offset: 0 }; // new, or rewritten shorter
    }
    if (known.offset >= size) {
      return { title: known.title, done: true }; // nothing added since
    }
    const fh = await fs.promises.open(file, 'r');
    try {
      while (known.offset < size && budget.bytes > 0) {
        const want = Math.min(CUSTOM_CHUNK, size - known.offset);
        // Only as big as needed (a working session adds a few KB a poll), and never zeroed: it's read into at once.
        if (!budget.buf || budget.buf.length < want) {
          budget.buf = Buffer.allocUnsafe(want);
        }
        const buf = budget.buf;
        const bytesRead: number = (await fh.read(buf, 0, want, known.offset)).bytesRead;
        budget.bytes -= bytesRead;
        if (!bytesRead) {
          break;
        }
        // Up to the last whole line; a line longer than a chunk is skipped (it's no title record).
        let end: number = buf.lastIndexOf(0x0a, bytesRead - 1) + 1;
        if (end === 0) {
          if (known.offset + bytesRead < size) {
            end = bytesRead;
          } else {
            break; // the last line is still being written
          }
        }
        const title = lastCustomTitle(buf.subarray(0, end).toString('utf8'));
        known = { offset: known.offset + end, title: title ?? known.title };
      }
    } finally {
      await fh.close();
    }
    this.customs.set(file, known);
    // Not done: the budget ran out, or the last line is still being written; the title may be an older one.
    return { title: known.title, done: known.offset >= size };
  }

  /** One transcript's title and last request, read again only when its size or time changed. */
  private async info(file: string, st: fs.Stats): Promise<TailInfo> {
    const old = this.cache.get(file);
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) {
      return old;
    }
    let found = scanTail(await readTail(file, st.size, TAIL_FIRST), st.size <= TAIL_FIRST);
    if (!found.request && st.size > TAIL_FIRST) {
      const more = scanTail(await readTail(file, st.size, TAIL_MAX), st.size <= TAIL_MAX);
      found = { title: found.title ?? more.title, request: more.request };
    }
    const info = { size: st.size, mtimeMs: st.mtimeMs, ...found };
    this.cache.set(file, info);
    return info;
  }

  /**
   * Your last message to the Claude Code session titled `title` in `cwd`, looked for in each settings folder
   * (~/.claude and other accounts' CLAUDE_CONFIG_DIR). Undefined when no session matches.
   */
  async find(configDirs: string[], cwd: string, title: string | undefined, budget: ReadBudget = readBudget()): Promise<string | undefined> {
    const want = title?.trim();
    if (!want) {
      return undefined;
    }
    const files: { file: string; st: fs.Stats }[] = [];
    for (const dir of configDirs) {
      files.push(...(await this.listing(claudeProjectDir(dir, cwd))));
    }
    // Accounts can share their conversations (one's projects folder a link to the other's): each file once.
    const seen = new Set<string>();
    const unique = files.filter(({ st }) => {
      const id = `${st.dev}:${st.ino}`;
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
    unique.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const newest = unique.slice(0, MAX_FILES);
    for (const { file, st } of newest) {
      try {
        const info = await this.info(file, st);
        if (info.title !== want) {
          continue;
        }
        // A title near the end can be a later automatic one of a session renamed long before: its name is that one.
        // Only a complete read can say the file has another name (a partial one may have an older /rename).
        const custom = await this.customTitle(file, st.size, budget);
        if (!custom.done || !custom.title || custom.title === want) {
          return info.request;
        }
      } catch {
        // Unreadable: try the next one.
      }
    }
    if (want === DEFAULT_TITLE) {
      return undefined; // a session with no title yet: no /rename to look for
    }
    // No title at the end matches: a session renamed (/rename) long ago keeps that name further back.
    for (const { file, st } of newest) {
      try {
        // Only from a whole read: a half-read file may still have an older name it was given before.
        const custom = await this.customTitle(file, st.size, budget);
        if (custom.done && custom.title === want) {
          return (await this.info(file, st)).request;
        }
      } catch {
        // Unreadable: try the next one.
      }
    }
    return undefined;
  }

  /** Forget transcripts not looked at in the last call set (keeps the cache to the sessions still around). */
  prune(keep: Set<string>) {
    for (const project of this.listings.keys()) {
      if (!keep.has(project)) {
        this.listings.delete(project);
      }
    }
    for (const file of this.cache.keys()) {
      if (!keep.has(path.dirname(file))) {
        this.cache.delete(file);
        this.customs.delete(file);
      }
    }
  }
}
