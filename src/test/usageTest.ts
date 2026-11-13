// Usage readers against a fixture home directory shaped like the real tools' files
// (codex-cli 0.157.0, Claude Code 2.1.289, kiro-cli 2.27.1), plus the opt-in status line script.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeAccountKey, claudeCaptureFile, claudeStatusLineScript, codexLiveUsage, currentBlock, legacyClaudeCaptureFile, readUsage, todayDelta } from '../usage';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-usage-'));
const put = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), body);
};
const H = 3600_000;
const now = Date.UTC(2026, 9, 5, 18, 30); // 2026-10-05 18:30 UTC
const iso = (t: number) => new Date(t).toISOString();
const sec = (t: number) => Math.floor(t / 1000);

// Codex: an older rollout with rate limits, and a newer one without (newest-first search must skip it).
put('.codex/sessions/2026/10/05/rollout-a.jsonl', [
  JSON.stringify({ timestamp: iso(now - 2 * H), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 28, window_minutes: 300, resets_at: sec(now + H) },
    secondary: { used_percent: 23, window_minutes: 10080, resets_at: sec(now - H) }, plan_type: 'team' } } }),
  JSON.stringify({ timestamp: iso(now - H), type: 'response_item', payload: { type: 'message' } }),
].join('\n'));
put('.codex/sessions/2026/10/05/rollout-b.jsonl', JSON.stringify({ type: 'session_meta', payload: {} }) + '\n');
fs.utimesSync(path.join(home, '.codex/sessions/2026/10/05/rollout-a.jsonl'), new Date(now - H), new Date(now - H));

// Claude: one message in an earlier block, two in the current one (one written twice while streaming).
const msg = (t: number, id: string, input: number, output: number, cacheRead = 0) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(t), requestId: `r-${id}`, message: { id, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 10, cache_read_input_tokens: cacheRead } } });
put('.claude/projects/-p/s1.jsonl', [
  msg(now - 7 * H, 'm0', 1000, 1000),
  msg(now - 2 * H - 10 * 60_000, 'm1', 100, 50, 5000),
  msg(now - 2 * H - 10 * 60_000, 'm1', 100, 50, 5000),
  JSON.stringify({ type: 'user', timestamp: iso(now - H), message: { content: 'hi' } }),
  msg(now - 30 * 60_000, 'm2', 200, 100),
].join('\n'));
put('.herdr-cockpit/claude-usage.json', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42.5, resets_at: sec(now + 2 * H) }, seven_day: { used_percentage: 11, resets_at: sec(now + 50 * H) } } }));

// Kiro: credits today, earlier this month, and last month (ignored).
const local = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
put('.kiro/sessions/cli/a.json', JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [
  { end_timestamp: iso(local(5, 9)), metering_usage: [{ value: 0.25, unit: 'credit' }, { value: 0.05, unit: 'credit' }] },
  { end_timestamp: iso(local(2, 9)), metering_usage: [{ value: 1.5, unit: 'credit' }] },
  { end_timestamp: iso(new Date(2026, 8, 30).getTime()), metering_usage: [{ value: 9, unit: 'credit' }] },
] } } }));

(async () => {
  const kiroNow = local(5, 12);
  const usage = await readUsage(home, now);
  const by = (id: string) => usage.find((u) => u.id === id)!;
  assert.deepStrictEqual(usage.map((u) => u.id), ['claude', 'codex', 'kiro']);

  const codex = by('codex');
  assert.strictEqual(codex.plan, 'team');
  assert.deepStrictEqual(codex.windows.map((w) => [w.label, w.usedPercent, !!w.reset]), [['5h', 28, false], ['7d', 0, true]], 'weekly window already reset');
  assert.strictEqual(codex.asOf, now - 2 * H);
  console.log('✓ codex rate limits (5h / 7d, reset windows)');

  const claude = by('claude');
  assert.deepStrictEqual(claude.windows.map((w) => [w.label, w.usedPercent]), [['5h', 42.5], ['7d', 11]]);
  assert.strictEqual(claude.canSetUpLimits, undefined);
  assert.deepStrictEqual(claude.block, { startsAt: now - 3 * H, endsAt: now + 2 * H, tokens: 160 + 310, cacheRead: 5000, exact: true },
    'the real session window (reset time − 5h); streamed duplicate counted once');
  console.log('✓ claude limits from status line capture + current 5-hour block');

  const kiro = (await readUsage(home, kiroNow)).find((u) => u.id === 'kiro')!;
  assert.deepStrictEqual([kiro.credits!.today.toFixed(2), kiro.credits!.month.toFixed(2)], ['0.30', '1.80']);
  assert.deepStrictEqual(kiro.windows, [], 'no allowance set: no bar');
  const kiroLimited = (await readUsage(home, kiroNow, { kiroMonthlyCredits: 50 })).find((u) => u.id === 'kiro')!;
  assert.deepStrictEqual(
    [kiroLimited.credits!.limit, kiroLimited.windows[0].label, kiroLimited.windows[0].usedPercent.toFixed(1), kiroLimited.windows[0].resetsAt],
    [50, 'mo', '3.6', new Date(2026, 10, 1).getTime()],
    'allowance: % of the month used, resets on the 1st',
  );
  console.log('✓ kiro credits today / this month');

  // A status line set up before the rename (Herdr Hub) still writes ~/.herdr-hub/claude-usage.json: read the newer one.
  const legacy = legacyClaudeCaptureFile(home);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 77, resets_at: sec(now + H) } } }));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(legacy, later, later);
  assert.strictEqual((await readUsage(home, now))[0].windows[0].usedPercent, 77, 'the newer (pre-rename) capture wins');
  fs.rmSync(claudeCaptureFile(home));
  assert.strictEqual((await readUsage(home, now))[0].windows[0].usedPercent, 77, 'the pre-rename capture alone still works');
  fs.rmSync(legacy);
  console.log('✓ claude capture from before the rename still read');

  const noCapture = (await readUsage(home, now))[0];
  assert.strictEqual(noCapture.canSetUpLimits, true, 'offers setup without a capture');
  const est = Math.floor((now - 2 * H - 10 * 60_000) / H) * H;
  assert.deepStrictEqual(noCapture.block, { startsAt: est, endsAt: est + 5 * H, tokens: 470, cacheRead: 5000, exact: false }, 'estimated block from the first message hour');
  const live = { id: 'codex', name: 'Codex', windows: [{ label: '5h', usedPercent: 3 }], live: true };
  assert.strictEqual((await readUsage(home, now, { codexLive: live })).find((u) => u.id === 'codex'), live, 'live Codex numbers win over logs');
  assert.deepStrictEqual((await readUsage(home, now, { only: new Set(['kiro']) })).map((u) => u.id), ['kiro'], 'agents not running are not read');
  // A second Claude Code account (CLAUDE_CONFIG_DIR=~/.claude-second): its own card, from its own folder and capture.
  assert.strictEqual(claudeAccountKey(path.join(home, '.claude'), home), '');
  assert.strictEqual(claudeAccountKey(path.join(home, '.claude-second'), home), '.claude-second');
  put('.claude-second/projects/-p/s.jsonl', msg(now - 20 * 60_000, 'n1', 300, 30));
  put('.herdr-cockpit/claude-usage-.claude-second.json', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 9, resets_at: sec(now + H) } } }));
  const accounts = [{ configDir: path.join(home, '.claude'), name: 'Claude (main)' }, { configDir: path.join(home, '.claude-second'), name: 'Claude (second)' }];
  const two = await readUsage(home, now, { only: new Set(['claude']), claudeAccounts: accounts });
  assert.deepStrictEqual(two.map((u) => [u.id, u.kind, u.account, u.name]), [['claude', 'claude', undefined, 'Claude (main)'], ['claude:.claude-second', 'claude', '.claude-second', 'Claude (second)']]);
  assert.strictEqual(two[1].windows[0].usedPercent, 9, "the second account's own plan limits");
  assert.notDeepStrictEqual(two[1].windows, two[0].windows);
  console.log('✓ one card per Claude Code account');
  assert.strictEqual(currentBlock([{ ts: now - 6 * H, tokens: 1, cacheRead: 0 }], now), undefined, 'no current block after 5h idle');
  console.log('✓ claude without capture offers setup');

  // The status line script: saves only rate_limits (with jq) and prints the limits.
  const script = path.join(home, 'statusline.sh');
  fs.writeFileSync(script, claudeStatusLineScript(claudeCaptureFile(home)));
  const input = JSON.stringify({ cwd: '/secret/path', session_id: 's', rate_limits: { five_hour: { used_percentage: 42.6, resets_at: 1 }, seven_day: { used_percentage: 7, resets_at: 2 } } });
  const hasJq = (() => { try { execFileSync('sh', ['-c', 'command -v jq']); return true; } catch { return false; } })();
  const printed = execFileSync('sh', [script], { input }).toString().trim();
  const saved = JSON.parse(fs.readFileSync(claudeCaptureFile(home), 'utf8'));
  if (hasJq) {
    assert.strictEqual(printed, '5h 42% · 7d 7%');
    assert.deepStrictEqual(Object.keys(saved), ['rate_limits'], 'only rate_limits are kept');
  }
  assert.strictEqual(saved.rate_limits.five_hour.used_percentage, 42.6);
  console.log(`✓ status line script saves rate_limits${hasJq ? ' (jq: only that) and prints them' : ''}`);
  // Live Codex: a fake `codex app-server` speaking the protocol (initialize, then account/rateLimits/read).
  const fake = path.join(home, 'codex');
  fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(2);
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: { userAgent: 'fake' } }));
  if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: m.id, result: { rateLimits: {
    planType: 'team', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: ${sec(Date.now() + H)} },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: ${sec(Date.now() + 50 * H)} } } } }));
});
`, { mode: 0o755 });
  const lu = await codexLiveUsage(fake);
  assert.deepStrictEqual([lu?.live, lu?.plan, lu?.windows.map((w) => [w.label, w.usedPercent])], [true, 'team', [['5h', 12], ['7d', 40]]]);
  assert.strictEqual(await codexLiveUsage(path.join(home, 'missing-codex'), 2000), undefined, 'no Codex: undefined, no throw');
  console.log('✓ live Codex limits via app-server protocol');

  // Today (since local midnight): what each session's running totals grew by today.
  assert.strictEqual(todayDelta([{ ts: 1, value: 3 }, { ts: 10, value: 5 }], 5), 2, 'grew from 3 to 5 today');
  assert.strictEqual(todayDelta([{ ts: 10, value: 4 }], 5), 4, 'started today');
  assert.strictEqual(todayDelta([{ ts: 1, value: 3 }], 5), 0, 'nothing today');
  assert.strictEqual(todayDelta([{ ts: 1, value: 9 }, { ts: 10, value: 2 }], 5), 2, 'a total that went down started over');
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-usage-today-'));
  const put2 = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(home2, rel)), { recursive: true });
    fs.writeFileSync(path.join(home2, rel), body);
  };
  const midnight = new Date(2026, 9, 5).getTime();
  const noon = midnight + 12 * H;
  // Claude: cost records carry no time of their own; the line before dates them (yesterday's, then today's).
  const costState = (cost: number, added: number, removed: number) =>
    JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD: cost, totalLinesAdded: added, totalLinesRemoved: removed });
  put2('.claude/projects/-p/s2.jsonl', [
    msg(midnight - 2 * H, 'y1', 1000, 1000),
    costState(3, 100, 10),
    msg(midnight + H, 't1', 100, 50, 2000),
    costState(5.5, 160, 25),
  ].join('\n'));
  // Codex: running token totals in one session log, before and after midnight, and credits.
  const tokenCount = (t: number, total: number, cached: number, extra: object = {}) =>
    JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total, cached_input_tokens: cached } }, ...extra } });
  put2('.codex/sessions/2026/10/05/rollout-c.jsonl', [
    tokenCount(midnight - H, 1000, 400),
    tokenCount(midnight + 2 * H, 3000, 1000, { rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: sec(noon + H) }, credits: { has_credits: true, unlimited: false, balance: '12.5' } } }),
  ].join('\n'));
  const day = await readUsage(home2, noon);
  const claudeToday = day.find((u) => u.id === 'claude')!.today;
  assert.deepStrictEqual(claudeToday, { tokens: 160, cacheRead: 2000, costUSD: 2.5, linesAdded: 60, linesRemoved: 15 }, "today's tokens, and what the session's cost and lines grew by");
  const codexDay = day.find((u) => u.id === 'codex')!;
  assert.deepStrictEqual(codexDay.today, { tokens: 1400, cacheRead: 600 }, "today's Codex tokens: the running total's growth since midnight");
  assert.deepStrictEqual(codexDay.codexCredits, { balance: 12.5, unlimited: false });
  fs.rmSync(home2, { recursive: true, force: true });
  console.log("✓ today: tokens, cache share, Claude's cost and lines, Codex credits");

  fs.rmSync(home, { recursive: true, force: true });
  console.log('\nusage tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
