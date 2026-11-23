// What is a pane doing right now? The snapshot only says a terminal exists, so for shell panes we
// ask Herdr for the foreground process (pane.process_info) and recent output (pane.read), and boil
// that down to "running X" or "at the prompt, last ran Y", plus the last lines of output.
// Agents that need attention (blocked/done) get a short preview of their screen the same way.
// No vscode imports (tested standalone).

import type { PaneReader } from '../drivers/backend';
import type { AgentStatus, PaneProcessInfo, PaneProcessInfoProcess } from '../drivers/herdr/herdrTypes';

export interface PaneActivity {
  /** Shells only. 'prompt': waiting for input. 'running': a program owns the terminal. */
  state?: 'prompt' | 'running';
  /** What's running now, or the last command run at the prompt. */
  command?: string;
  /** Text typed at the prompt but not run yet. */
  typed?: string;
  /** Last meaningful output lines, oldest first. */
  output: string[];
  /** The output looks like a failure (error, refused, traceback, ...). */
  failed: boolean;
  /** When this pane's output last changed, as observed by polling (epoch ms). */
  changedAt?: number;
}

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'xonsh', 'elvish']);
const INTERPRETERS = /^(python[\d.]*|node|bun|deno|ruby|perl|php|java|uv|uvx|npx|npm|pnpm|yarn)$/;
/** Full-screen programs whose screen isn't useful as an output preview. */
const FULLSCREEN = /^(n?vim?|nano|emacs|less|more|man|top|htop|btop|lazygit|tig|tmux|fzf|k9s|herdr.*)$/;
const FAILURE =
  /\b(error|errors|failed|failure|refused|denied|not found|no such file|no matches found|traceback|exception|fatal|panic|timed out|cannot|can't)\b/i;
/** [(venv) ]user@host dir %  |  ❯  |  ➜ ... — with whatever was typed after it in group 1. */
const PROMPT = /^(?:\([^)\s]+\)\s+)*(?:\S+@\S+[^%$#\n]*?[%$#]|\S*[❯➜λ›»])(?:\s+(.*))?$/;
/** Virtualenv activation typed by editor extensions (`source …/.venv/bin/activate`), and its wrapped tail. */
const ACTIVATION = /^(?:source|\.)\s+\S*(?:venv|activate|\/)\S*$|^\S*\/bin\/acti(?:vate)?\S*$/;
/** Agent UI hints and footers that say nothing about the work. */
const AGENT_NOISE =
  /\/clear to save|disable recaps|restart to update|^▸ credits:|shift\+tab|esc to interrupt|\? for shortcuts|ask a question or describe a task|how is claude doing|1: bad\s+2: fine/i;
const RULE = /^[\s─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼▔▁\-_=]*$/;
const EDGES = /^[\s│┃║╭╮╰╯┌┐└┘├┤]+|[\s│┃║╭╮╰╯┌┐└┘├┤]+$/g;

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
/** A command line as typed, minus env assignments, continuation backslashes and long paths. */
const shortCommand = (cmd: string) =>
  cmd
    .replace(/\s*\\$/, '')
    .replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '')
    .split(/\s+/)
    .map((a) => (a.startsWith('/') && a.length > 1 ? base(a) : a))
    .join(' ');
const clean = (lines: string[]) => lines.map((l) => l.replace(EDGES, '')).filter((l) => l && !RULE.test(l));

/**
 * "zsh", "-zsh", "/bin/zsh" and wrapped shells like Kiro's "zsh (kiro-cli-term)" are shells. macOS truncates
 * process names to 15 characters ("zsh (kiro-cli-t"), so drop everything from " (" on.
 */
export const isShellProcess = (name: string) => SHELLS.has(base(name.replace(/\s*\(.*$/, '')).replace(/^-/, '').toLowerCase());

/** The process that owns the terminal: the foreground group leader, else the last non-shell. */
export function leaderProcess(info?: PaneProcessInfo): PaneProcessInfoProcess | undefined {
  const procs = info?.foreground_processes ?? [];
  return (
    procs.find((p) => p.pid === info?.foreground_process_group_id) ??
    [...procs].reverse().find((p) => !isShellProcess(p.name)) ??
    procs[0]
  );
}

/** "python app.py", "vi config.yaml", "npm run dev" — short and recognizable. */
export function describeProcess(p: PaneProcessInfoProcess): string {
  const argv = p.argv?.length ? p.argv : (p.cmdline ?? p.name).split(/\s+/);
  const prog = base(argv[0] || p.name).toLowerCase() === p.name.toLowerCase() ? p.name : base(argv[0] || p.name);
  const args = argv.slice(1).map((a) => (a.includes('/') && !a.startsWith('-') ? base(a) : a));
  if (INTERPRETERS.test(prog.toLowerCase())) {
    // Show the script or module, not the interpreter's flags.
    const m = args.indexOf('-m');
    const target = m >= 0 ? args.slice(m, m + 2) : args.filter((a) => !a.startsWith('-')).slice(0, 2);
    return [prog.toLowerCase(), ...target].join(' ');
  }
  const s = [prog, ...args].join(' ');
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** Summarize a shell pane from its foreground process and recent (unwrapped) output. */
export function summarizeShell(info: PaneProcessInfo | undefined, text: string): Omit<PaneActivity, 'changedAt'> {
  let lines = text.split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const leader = leaderProcess(info);

  if (leader && !isShellProcess(leader.name)) {
    const output = FULLSCREEN.test(base(leader.argv?.[0] ?? leader.name)) || FULLSCREEN.test(leader.name) ? [] : clean(lines).slice(-2);
    return { state: 'running', command: describeProcess(leader), output, failed: output.some((l) => FAILURE.test(l)) };
  }

  // At the prompt: the last prompt line may carry typed-but-unsent text; the prompt line before
  // it holds the last command, and everything between them is that command's output.
  // Activation commands an editor typed in aren't the user's work: a prompt carrying one becomes a
  // bare prompt, and wrapped leftovers of it are dropped.
  lines = lines.flatMap((l) => {
    if (ACTIVATION.test(l.trim())) return [];
    const cmd = PROMPT.exec(l.trim())?.[1]?.trim();
    return cmd && ACTIVATION.test(cmd) ? [l.slice(0, l.lastIndexOf(cmd)).trimEnd()] : [l];
  });
  const prompts = lines.map((l, i) => ({ i, m: PROMPT.exec(l.trim()) })).filter((x) => x.m);
  const last = prompts[prompts.length - 1];
  let typed: string | undefined;
  let command: string | undefined;
  let body = lines;
  if (last && last.i === lines.length - 1) {
    const prev = [...prompts].reverse().find((x) => x.i < last.i && x.m![1]?.trim());
    command = prev && shortCommand(prev.m![1].trim());
    typed = last.m![1]?.trim() ? shortCommand(last.m![1].trim()) : undefined;
    if (typed === command) typed = undefined; // recalled from history, not news
    body = lines.slice(prev ? prev.i + 1 : 0, last.i);
  }
  const output = clean(body.filter((l) => !PROMPT.test(l.trim()))).slice(-2);
  return { state: 'prompt', command, typed, output, failed: output.some((l) => FAILURE.test(l)) };
}

/**
 * The last meaningful lines of an agent's screen: its question when blocked, otherwise the tail of
 * its last reply (e.g. Claude's "※ recap: ..."). Up to 5 lines; the view decides how many to show.
 */
export function summarizeAgent(text: string, status: AgentStatus): string[] {
  let lines = text.split('\n').map((l) => l.trimEnd());
  if (status !== 'blocked') {
    // Drop the input box and footer: everything from the first rule near the bottom.
    // (A blocked agent's question lives in that box, so keep it there.)
    const tail = Math.max(0, lines.length - 8);
    const cut = lines.findIndex((l, i) => i >= tail && l.trim() && RULE.test(l));
    if (cut > 0) lines = lines.slice(0, cut);
  }
  return clean(lines)
    .filter((l) => !/^\s*[❯›>]\s*$/.test(l) && !AGENT_NOISE.test(l))
    .slice(-5);
}

export interface ActivityTarget {
  paneId: string;
  kind: 'shell' | 'agent';
  status?: AgentStatus;
}

/** Polls each pane's foreground process and recent text (pane.process_info / pane.read in Herdr) and remembers what it saw. */
export class ActivityWatcher {
  private byPane = new Map<string, PaneActivity & { sig: string }>();
  private busy = false;

  constructor(
    private reader: PaneReader,
    private concurrency = 6,
  ) {}

  get(paneId: string): PaneActivity | undefined {
    return this.byPane.get(paneId);
  }

  /** Returns true when anything visible changed. */
  async poll(targets: ActivityTarget[]): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      let changed = false;
      const queue = [...targets];
      const worker = async () => {
        for (let t = queue.shift(); t; t = queue.shift()) if (await this.pollOne(t)) changed = true;
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
      const live = new Set(targets.map((t) => t.paneId));
      for (const id of [...this.byPane.keys()])
        if (!live.has(id)) {
          this.byPane.delete(id);
          changed = true;
        }
      return changed;
    } finally {
      this.busy = false;
    }
  }

  private async pollOne(t: ActivityTarget): Promise<boolean> {
    try {
      const shell = t.kind === 'shell';
      // Shells: their foreground process and plain recent output; agents: what Herdr's detection reads.
      let infoRead: Promise<PaneProcessInfo | undefined> = Promise.resolve(undefined);
      let textRead: Promise<string>;
      if (shell) {
        infoRead = this.reader.processInfo(t.paneId);
        textRead = this.reader.readText(t.paneId, 'recent_unwrapped', 40);
      } else {
        textRead = this.reader.readText(t.paneId, 'detection', 60);
      }
      const [info, text] = await Promise.all([infoRead, textRead]);
      const summary =
        t.kind === 'shell' ? summarizeShell(info, text) : { output: summarizeAgent(text, t.status ?? 'unknown'), failed: false };
      const prev = this.byPane.get(t.paneId);
      // The read revision isn't populated (always 0), so detect output changes by content.
      const sig = `${summary.command ?? ''}\u0000${text}`;
      const changedAt = prev && prev.sig !== sig ? Date.now() : prev?.changedAt;
      const next = { ...summary, changedAt, sig };
      this.byPane.set(t.paneId, next);
      return !prev || JSON.stringify({ ...prev, sig: 0 }) !== JSON.stringify({ ...next, sig: 0 });
    } catch {
      // Pane closed between snapshot and poll, or the server went away; the next snapshot sorts it out.
      return false;
    }
  }
}
