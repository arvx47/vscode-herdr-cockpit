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

export class SessionRequests {
  private cache = new Map<string, TailInfo>();

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
  async find(configDirs: string[], cwd: string, title: string | undefined): Promise<string | undefined> {
    const want = title?.trim();
    if (!want) {
      return undefined;
    }
    const files: { file: string; st: fs.Stats }[] = [];
    for (const dir of configDirs) {
      const project = claudeProjectDir(dir, cwd);
      let names: string[];
      try {
        names = await fs.promises.readdir(project);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) {
          continue;
        }
        const file = path.join(project, name);
        try {
          files.push({ file, st: await fs.promises.stat(file) });
        } catch {
          // Removed meanwhile.
        }
      }
    }
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { file, st } of files.slice(0, MAX_FILES)) {
      try {
        const info = await this.info(file, st);
        if (info.title === want) {
          return info.request;
        }
      } catch {
        // Unreadable: try the next one.
      }
    }
    return undefined;
  }

  /** Forget transcripts not looked at in the last call set (keeps the cache to the sessions still around). */
  prune(keep: Set<string>) {
    for (const file of this.cache.keys()) {
      if (!keep.has(path.dirname(file))) {
        this.cache.delete(file);
      }
    }
  }
}
