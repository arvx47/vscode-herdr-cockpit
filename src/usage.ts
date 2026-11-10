// Plan usage of the coding agents (Claude Code, Codex, Kiro), read from each tool's own local files.
// Nothing leaves the machine and no credentials are read: only numeric usage fields are parsed.
// No vscode imports (tested standalone against fixture directories).
//
// Sources (verified against Claude Code 2.1.289, codex 0.160, kiro-cli 2.27.1):
//  - Codex (live): `codex app-server` speaks its JSON-RPC protocol on stdio; `account/rateLimits/read` returns
//    the same numbers as Codex's /usage, authenticated by Codex itself (we never touch its login).
//  - Codex (fallback): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl `token_count` lines carry `rate_limits`,
//    but only as of Codex's last model request (newer Codex versions stopped writing these files).
//  - Claude Code: plan limits are only given to a status-line command (`rate_limits.five_hour|seven_day`
//    {used_percentage, resets_at}); our opt-in status line saves them to CLAUDE_CAPTURE. Token usage per
//    message is in ~/.claude/projects/**/*.jsonl (`message.usage`), summed per 5-hour block.
//  - Kiro: ~/.kiro/sessions/cli/*.json, `session_state.conversation_metadata.user_turn_metadatas[]`
//    {end_timestamp, metering_usage[] {value, unit: "credit"}}. The plan allowance isn't stored locally or
//    exposed by `kiro-cli acp` (v2: `_kiro/account/getUsage` is "Method not found"; v3 starts Kiro's whole
//    agent engine and creates sessions), so the user enters it (setting herdr.kiroMonthlyCredits).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { findTool } from './tools';
import { LEGACY_NAME } from './hubFiles';

export interface UsageWindow {
  /** "5h", "7d", ... */
  label: string;
  usedPercent: number;
  /** Epoch ms when the window resets. */
  resetsAt?: number;
  /** The snapshot is older than the reset: the window has started over. */
  reset?: boolean;
}

export interface ProviderUsage {
  /** Agent kind, as Herdr names it: "claude", "codex", "kiro". */
  id: string;
  name: string;
  plan?: string;
  /** Plan limits, as % used. */
  windows: UsageWindow[];
  /** When the plan-limit numbers were recorded (epoch ms). */
  asOf?: number;
  /** The numbers were just fetched from the provider (not read from a log). */
  live?: boolean;
  /**
   * Claude: tokens in the current 5-hour session (from local transcripts). `exact` when the window comes
   * from Claude's own reset time; otherwise estimated from the first message's hour.
   */
  block?: { tokens: number; cacheRead: number; startsAt: number; endsAt: number; exact: boolean };
  /** Kiro: credits used, and the monthly allowance when the user set one. */
  credits?: { today: number; month: number; limit?: number };
  /** Claude only: plan limits need the opt-in status line. */
  canSetUpLimits?: boolean;
}

/** Where our Claude Code status line saves its input (see claudeStatusLineScript). */
export const claudeCaptureFile = (home: string) => path.join(home, '.herdr-cockpit', 'claude-usage.json');
/** Where a status line installed before the rename (Herdr Hub) saves it: still read, so that setup keeps working. */
export const legacyClaudeCaptureFile = (home: string) => path.join(home, `.${LEGACY_NAME}`, 'claude-usage.json');

const HOUR = 3600_000;
const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);
const mtime = (p: string) => fs.promises.stat(p).then((s) => s.mtimeMs, () => 0);
const windowLabel = (minutes: number) => (minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);

function window(label: string, usedPercent: unknown, resetsAtSec: unknown, now: number): UsageWindow | undefined {
  if (typeof usedPercent !== 'number') return;
  const resetsAt = typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : undefined;
  const reset = resetsAt !== undefined && resetsAt <= now;
  return { label, usedPercent: reset ? 0 : Math.max(0, usedPercent), resetsAt: reset ? undefined : resetsAt, ...(reset && { reset }) };
}

/** Files under `dir` (to `depth` levels) ending in `ext`, modified after `since`, newest first. */
async function recentFiles(dir: string, ext: string, since: number, depth: number): Promise<{ file: string; mtime: number }[]> {
  const out: { file: string; mtime: number }[] = [];
  const walk = async (d: string, level: number) => {
    const entries = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory() && level < depth) return walk(p, level + 1);
        if (e.isFile() && e.name.endsWith(ext)) {
          const m = await mtime(p);
          if (m >= since) out.push({ file: p, mtime: m });
        }
      }),
    );
  };
  await walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The last `bytes` of a file as lines (the first, possibly partial, line dropped). */
async function tailLines(file: string, bytes: number): Promise<string[]> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await fh.close();
  }
}

// ---------- Codex ----------

/** Where Codex installs itself (a GUI-launched VS Code may not have these on PATH). */
export function codexBinary(home: string): string {
  return findTool('codex', [path.join(home, '.local', 'bin', 'codex'), path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex')], home);
}

/**
 * Live Codex limits: starts `codex app-server` (stdio JSON-RPC), says hello, asks
 * `account/rateLimits/read`, and exits. Undefined when Codex isn't installed, logged out or slow.
 */
export function codexLiveUsage(bin: string, timeoutMs = 10_000): Promise<ProviderUsage | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (u: ProviderUsage | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      resolve(u);
    };
    const proc = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    proc.on('error', () => finish(undefined));
    proc.on('exit', () => finish(undefined));
    proc.stdin.on('error', () => finish(undefined)); // EPIPE if Codex exits early
    const send = (o: object) => proc.stdin.write(JSON.stringify(o) + '\n');
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return finish(undefined);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (m.id === 2) {
          const rl = m.result?.rateLimits;
          if (m.error || !rl) return finish(undefined);
          const now = Date.now();
          const windows = [rl.primary, rl.secondary]
            .filter((w) => w && typeof w.usedPercent === 'number')
            .map((w) => window(windowLabel(w.windowDurationMins ?? 0), w.usedPercent, w.resetsAt, now))
            .filter((w): w is UsageWindow => !!w);
          finish({ id: 'codex', name: 'Codex', plan: typeof rl.planType === 'string' ? rl.planType : undefined, windows, asOf: now, live: true });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'herdr-cockpit', title: 'Herdr Cockpit', version: '1' } } });
  });
}

async function codexUsage(home: string, now = Date.now()): Promise<ProviderUsage | undefined> {
  const root = path.join(home, '.codex', 'sessions');
  if (!(await exists(root))) return;
  const files = await recentFiles(root, '.jsonl', now - 30 * 24 * HOUR, 3);
  for (const { file } of files.slice(0, 12)) {
    const lines = await tailLines(file, 512 * 1024).catch(() => []);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let o: any;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const rl = o?.payload?.rate_limits;
      if (!rl) continue;
      const windows = [rl.primary, rl.secondary]
        .filter((w) => w && typeof w.window_minutes === 'number')
        .map((w) => window(windowLabel(w.window_minutes), w.used_percent, w.resets_at, now))
        .filter((w): w is UsageWindow => !!w);
      return { id: 'codex', name: 'Codex', plan: typeof rl.plan_type === 'string' ? rl.plan_type : undefined, windows, asOf: Date.parse(o.timestamp) || undefined };
    }
  }
  return files.length ? { id: 'codex', name: 'Codex', windows: [] } : undefined;
}

// ---------- Claude Code ----------

/** Splits message times into 5-hour blocks the way Claude's session windows start: at the hour of the first message. */
export function currentBlock(entries: { ts: number; tokens: number; cacheRead: number }[], now: number) {
  let block: { startsAt: number; endsAt: number; tokens: number; cacheRead: number; exact: boolean } | undefined;
  for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
    if (!block || e.ts >= block.endsAt) {
      const startsAt = Math.floor(e.ts / HOUR) * HOUR;
      block = { startsAt, endsAt: startsAt + 5 * HOUR, tokens: 0, cacheRead: 0, exact: false };
    }
    block.tokens += e.tokens;
    block.cacheRead += e.cacheRead;
  }
  return block && block.endsAt > now ? block : undefined;
}

async function claudeUsage(home: string, now = Date.now()): Promise<ProviderUsage | undefined> {
  const projects = path.join(home, '.claude', 'projects');
  if (!(await exists(path.join(home, '.claude')))) return;
  const usage: ProviderUsage = { id: 'claude', name: 'Claude Code', windows: [] };

  // Plan limits, if the opt-in status line has saved them (the newer of the current and pre-rename captures).
  const captures = await Promise.all([claudeCaptureFile(home), legacyClaudeCaptureFile(home)].map(async (f) => ({ f, at: await mtime(f) })));
  const capture = captures.filter((c) => c.at > 0).sort((a, b) => b.at - a.at)[0]?.f ?? claudeCaptureFile(home);
  try {
    const rl = JSON.parse(await fs.promises.readFile(capture, 'utf8'))?.rate_limits ?? {};
    usage.windows = [window('5h', rl.five_hour?.used_percentage, rl.five_hour?.resets_at, now), window('7d', rl.seven_day?.used_percentage, rl.seven_day?.resets_at, now)].filter(
      (w): w is UsageWindow => !!w,
    );
    usage.asOf = await mtime(capture);
  } catch {
    usage.canSetUpLimits = true;
  }

  // Tokens in the current 5-hour block. A block is at most 5h old, so transcripts untouched for 10h can't matter.
  const since = now - 10 * HOUR;
  const seen = new Set<string>();
  const entries: { ts: number; tokens: number; cacheRead: number }[] = [];
  for (const { file } of await recentFiles(projects, '.jsonl', since, 4)) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o?.message?.usage;
      const ts = Date.parse(o?.timestamp);
      if (!u || !(ts >= since)) continue;
      // Streaming writes the same message more than once.
      const key = `${o.message.id ?? ''}:${o.requestId ?? ''}`;
      if (key !== ':' && seen.has(key)) continue;
      seen.add(key);
      entries.push({
        ts,
        tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cacheRead: u.cache_read_input_tokens ?? 0,
      });
    }
  }
  // Claude reports when the 5-hour session resets: count exactly that window. Otherwise estimate it.
  const fiveHour = usage.windows.find((w) => w.label === '5h' && w.resetsAt);
  if (fiveHour?.resetsAt) {
    const startsAt = fiveHour.resetsAt - 5 * HOUR;
    const inWindow = entries.filter((e) => e.ts >= startsAt);
    usage.block = {
      startsAt,
      endsAt: fiveHour.resetsAt,
      tokens: inWindow.reduce((s, e) => s + e.tokens, 0),
      cacheRead: inWindow.reduce((s, e) => s + e.cacheRead, 0),
      exact: true,
    };
  } else usage.block = currentBlock(entries, now);
  return usage;
}

// ---------- Kiro ----------

async function kiroUsage(home: string, now = Date.now(), monthlyLimit = 0): Promise<ProviderUsage | undefined> {
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  if (!(await exists(dir))) return;
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const credits = { today: 0, month: 0 };
  for (const { file } of await recentFiles(dir, '.json', monthStart, 0)) {
    let turns: any[] = [];
    try {
      turns = JSON.parse(await fs.promises.readFile(file, 'utf8'))?.session_state?.conversation_metadata?.user_turn_metadatas ?? [];
    } catch {
      continue;
    }
    for (const t of Array.isArray(turns) ? turns : []) {
      const ts = Date.parse(t?.end_timestamp);
      if (!(ts >= monthStart)) continue;
      const used = (Array.isArray(t.metering_usage) ? t.metering_usage : [])
        .filter((m: any) => m?.unit === 'credit' && typeof m.value === 'number')
        .reduce((s: number, m: any) => s + m.value, 0);
      credits.month += used;
      if (ts >= dayStart) credits.today += used;
    }
  }
  if (!(monthlyLimit > 0)) return { id: 'kiro', name: 'Kiro', windows: [], credits };
  // Kiro's allowance renews monthly; the calendar month is the closest local stand-in for the billing cycle.
  const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return {
    id: 'kiro',
    name: 'Kiro',
    windows: [{ label: 'mo', usedPercent: (credits.month / monthlyLimit) * 100, resetsAt: nextMonth }],
    credits: { ...credits, limit: monthlyLimit },
  };
}

export interface UsageOptions {
  /** Live Codex numbers (from codexLiveUsage, fetched less often by the caller); win over Codex's logs. */
  codexLive?: ProviderUsage;
  /** Only these agents (Herdr agent kinds, e.g. the ones running now); all when omitted. */
  only?: Set<string>;
  /** Kiro monthly credit allowance; 0 = unknown. */
  kiroMonthlyCredits?: number;
}

/** Usage of each agent with data, in a stable order. Agents outside `only` aren't read at all. */
export async function readUsage(home: string, now = Date.now(), opts: UsageOptions = {}): Promise<ProviderUsage[]> {
  const want = (id: string) => !opts.only || opts.only.has(id);
  const all = await Promise.all(
    [
      want('claude') ? claudeUsage(home, now) : undefined,
      want('codex') ? (opts.codexLive ? Promise.resolve(opts.codexLive) : codexUsage(home, now)) : undefined,
      want('kiro') ? kiroUsage(home, now, opts.kiroMonthlyCredits) : undefined,
    ].map((p) => (p ?? Promise.resolve(undefined)).catch(() => undefined)),
  );
  return all.filter((u): u is ProviderUsage => !!u);
}

/**
 * The opt-in Claude Code status line: saves the JSON Claude Code passes it (for `rate_limits`) and
 * prints the limits. With jq it keeps only `rate_limits`; without, it saves the input as-is.
 */
export function claudeStatusLineScript(captureFile: string): string {
  return `#!/bin/sh
# Installed by Herdr Cockpit (VS Code). Claude Code shares plan usage (rate_limits) only with a status
# line command: this saves it for the Herdr sidebar and prints it. Remove "statusLine" from
# ~/.claude/settings.json to turn it off.
f="${captureFile}"
input=$(cat)
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$input" | jq -c '{rate_limits}' > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
  printf '%s' "$input" | jq -r '[(.rate_limits.five_hour.used_percentage // empty | "5h \\(floor)%"), (.rate_limits.seven_day.used_percentage // empty | "7d \\(floor)%")] | join(" · ")' 2>/dev/null
else
  printf '%s' "$input" > "$f.tmp" && mv "$f.tmp" "$f"
fi
`;
}
