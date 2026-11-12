// Shell quoting of paths put into scripts and settings (shQuote), the Claude status line script with and without
// jq under /bin/sh and dash (only rate_limits saved, privately, at a path full of shell characters), and the
// Claude transcript cache (unchanged files not re-read, appended lines read incrementally).
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeStatusLineScript, readUsage, shQuote } from '../usage';

const shells = [...new Map(['/bin/sh', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s)).map((s) => [fs.realpathSync(s), s])).values()];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-usage-sh-'));

// 1. shQuote: any string comes back unchanged as one shell word, nothing expanded
const nasty = [`plain`, `it's`, `a b`, `$HOME`, '`id`', `$(id)`, `"q"`, `back\\slash`, `''`, `new\nline`, `*`, `-n`, ``];
for (const sh of shells) {
  for (const s of nasty) {
    assert.strictEqual(execFileSync(sh, ['-c', `printf '%s' ${shQuote(s)}`]).toString(), s, `${sh}: ${JSON.stringify(s)}`);
  }
}
console.log(`✓ shQuote round-trips through ${shells.join(', ')}`);

// 2. the status line script, at a capture path with every character that broke the old double quotes
const dir = path.join(root, `it's a "$HOME" \`dir\``);
fs.mkdirSync(dir, { recursive: true });
const capture = path.join(dir, 'claude-usage.json');
const script = path.join(dir, 'claude-statusline.sh');
fs.writeFileSync(script, claudeStatusLineScript(capture));
// No jq: a PATH with only the tools the fallback uses.
const noJq = path.join(root, 'bin');
fs.mkdirSync(noJq);
for (const tool of ['cat', 'tr', 'sed', 'cut', 'mv']) {
  const found = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
  assert.ok(found, `${tool} not found`);
  fs.symlinkSync(found, path.join(noJq, tool));
}
const hasJq = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v jq']);
    return true;
  } catch {
    return false;
  }
})();
const input = JSON.stringify(
  {
    cwd: '/secret/path',
    transcript_path: '/secret/t.jsonl',
    model: { id: 'm', display_name: 'M' },
    rate_limits: { five_hour: { used_percentage: 42.6, resets_at: 1700000000 }, seven_day: { used_percentage: 7, resets_at: 1700500000 } },
    workspace: { current_dir: '/secret/path' },
  },
  null,
  2, // pretty-printed: the fallback must not depend on Claude Code's formatting
);
const modes: [string, NodeJS.ProcessEnv][] = [['without jq', { PATH: noJq }]];
if (hasJq) {
  modes.push(['with jq', { PATH: process.env.PATH }]);
}
for (const sh of shells) {
  for (const [mode, env] of modes) {
    fs.rmSync(capture, { force: true });
    const printed = execFileSync(sh, [script], { input, env }).toString().trim();
    assert.strictEqual(printed, '5h 42% · 7d 7%', `${sh} ${mode}: printed`);
    const saved = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepStrictEqual(
      saved,
      { rate_limits: { five_hour: { used_percentage: 42.6, resets_at: 1700000000 }, seven_day: { used_percentage: 7, resets_at: 1700500000 } } },
      `${sh} ${mode}: only rate_limits saved`,
    );
    assert.strictEqual(fs.statSync(capture).mode & 0o777, 0o600, `${sh} ${mode}: the capture is private`);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['claude-statusline.sh', 'claude-usage.json'], `${sh} ${mode}: no temp file left`);
  }
  // No rate_limits (not a Pro/Max plan, or before the first reply): saved as empty, nothing else kept.
  fs.rmSync(capture, { force: true });
  execFileSync(sh, [script], { input: JSON.stringify({ cwd: '/secret/path' }), env: { PATH: noJq } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { rate_limits: {} });
}
console.log(`✓ status line saves only rate_limits, privately (${modes.map((m) => m[0]).join(', ')})`);

// 3. Claude transcripts: parsed once, then only what was appended
(async () => {
  const home = path.join(root, 'home');
  const file = path.join(home, '.claude', 'projects', '-p', 's.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const H = 3600_000;
  const now = Date.now();
  const msg = (t: number, id: string, input: number) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), requestId: `r-${id}`, message: { id, usage: { input_tokens: input, output_tokens: 0 } } });
  const tokens = async () => (await readUsage(home, now, { only: new Set(['claude']) }))[0].block?.tokens;
  fs.writeFileSync(file, msg(now - H, 'a', 100) + '\n');
  assert.strictEqual(await tokens(), 100);
  // A line still being written (no newline yet) isn't counted, and isn't lost once it's complete.
  const partial = msg(now - H / 2, 'b', 20);
  fs.appendFileSync(file, partial.slice(0, 30));
  assert.strictEqual(await tokens(), 100, 'partial line not counted');
  fs.appendFileSync(file, partial.slice(30) + '\n' + msg(now - H / 2, 'b', 20) + '\n'); // written twice (streaming)
  assert.strictEqual(await tokens(), 120, 'appended lines read, duplicates counted once');
  // Unchanged file: served from the cache (a read would fail: the file is unreadable now).
  fs.chmodSync(file, 0o000);
  let unreadable = true;
  try {
    fs.readFileSync(file);
    unreadable = false; // running as root
  } catch {
    // expected
  }
  if (unreadable) {
    assert.strictEqual(await tokens(), 120, 'unchanged file not read again');
  }
  fs.chmodSync(file, 0o644);
  // Rewritten shorter: read again from the start.
  fs.writeFileSync(file, msg(now - H, 'c', 5) + '\n');
  assert.strictEqual(await tokens(), 5, 'a file that shrank is read again');
  console.log('✓ Claude transcripts are cached and read incrementally');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nusage script tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
