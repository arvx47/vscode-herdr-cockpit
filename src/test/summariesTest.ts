// Agent summaries (src/agents/summaries.ts): when a pane is due, an unchanged screen not sent twice, one call at a
// time, failures backing off, the text cleaned up, and the Claude Code CLI call (against a fake `claude`).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { accountOfProcess, claudeCliRunner, cleanSummary, paneSummaryEnv, Summaries, SUMMARY_MODEL, summaryEnv, trimScreen } from '../agents/summaries';
import type { AgentProfile } from '../agents/agentProfiles';
import { sleep } from '../util/format';

async function main() {
  let now = 1_000_000;
  const calls: string[] = [];
  let fail = false;
  let release: (() => void) | undefined;
  let changes = 0;
  const s = new Summaries(
    {
      run: async (_system, prompt) => {
        calls.push(prompt);
        if (release === undefined) {
          await new Promise<void>((r) => (release = r));
        }
        if (fail) {
          throw new Error('no login');
        }
        return '  "Fixing the **login** bug;\n tests pass."  ';
      },
      everyMs: 60_000,
      now: () => now,
    },
    () => changes++,
  );
  const ask = (status: string, screen: string, paneId = 'w1:p1') => {
    if (s.due(paneId, status)) {
      s.consider({ paneId, kind: 'claude', name: 'Login', status, screen });
    }
  };

  // 1. The first look: due, sent once; while it runs, not due again; the answer cleaned up.
  ask('working', '> fix login\n⏺ Editing auth.ts');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /<screen>\n> fix login\n⏺ Editing auth\.ts\n<\/screen>/);
  assert.match(calls[0], /Status: working/);
  assert.strictEqual(s.due('w1:p1', 'working'), false, 'not while its summary is being written');
  release!();
  await sleep(10);
  assert.strictEqual(s.get('w1:p1')?.text, 'Fixing the login bug; tests pass.');
  assert.strictEqual(changes, 1);
  console.log('✓ first summary: sent once, cleaned up');

  // 2. While working: not again before everyMs; then only if the screen changed.
  now += 30_000;
  ask('working', '> fix login\n⏺ Editing auth.ts\n⏺ Ran tests');
  assert.strictEqual(calls.length, 1, 'too soon');
  now += 31_000;
  ask('working', '> fix login\n⏺ Editing auth.ts');
  assert.strictEqual(calls.length, 1, 'same screen as last time: not sent');
  ask('working', '> fix login\n⏺ Editing auth.ts\n⏺ Ran tests');
  assert.strictEqual(calls.length, 2, 'changed and time: sent');
  await sleep(10);
  console.log('✓ while working: at most every everyMs, only a changed screen');

  // 3. A turn ending (done) asks at once, even right after the last one.
  now += 1000;
  ask('done', '⏺ Done: the login retries on 401.');
  assert.strictEqual(calls.length, 3);
  await sleep(10);
  console.log('✓ a turn ending asks at once');

  // 4. One call at a time: a second agent waits for the first.
  release = undefined;
  ask('working', 'agent two', 'w1:p2');
  ask('working', 'agent three', 'w1:p3');
  assert.strictEqual(calls.length, 4, 'the second waits');
  release!();
  await sleep(10);
  assert.strictEqual(calls.length, 5, 'then runs');
  await sleep(10);
  console.log('✓ one call at a time');

  // 5. Failures back off; a pane that's gone is forgotten.
  fail = true;
  ask('working', 'agent four', 'w1:p4');
  await sleep(10);
  assert.strictEqual(s.get('w1:p4'), undefined);
  now += 61_000;
  assert.strictEqual(s.due('w1:p4', 'working'), false, 'after a failure, twice as long');
  now += 60_000;
  assert.strictEqual(s.due('w1:p4', 'working'), true);
  fail = false;
  s.keep(['w1:p1']);
  assert.strictEqual(s.get('w1:p2'), undefined, 'forgotten');
  assert.ok(s.get('w1:p1'));
  console.log('✓ failures back off; gone panes forgotten');

  // 6. Text helpers.
  assert.strictEqual(trimScreen('\n\n\na\n\n\n\nb\n\n'), 'a\n\nb');
  assert.strictEqual(trimScreen(Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n')).split('\n')[0], 'l120');
  assert.strictEqual(cleanSummary('x'.repeat(400)).length, 278);
  assert.strictEqual(cleanSummary('# Working on `api`'), 'Working on api');
  console.log('✓ screen trimmed, summary cleaned');

  // 7. Which login writes them: a Claude row by name (any case), else the first; the editor's own CLAUDE_CONFIG_DIR
  //    never decides; a name that isn't a Claude row is an error naming the rows there are.
  const row = (name: string, kind: string, env: Record<string, string> = {}) => ({ name, kind, env, args: [], slug: name.toLowerCase() }) as unknown as AgentProfile;
  const rows = [row('Codex', 'codex'), row('Claude (Sungage)', 'claude'), row('Claude (arvx47)', 'claude', { CLAUDE_CONFIG_DIR: '/h/.claude-arvx47' })];
  const base = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/h/.claude-editor' };
  const picked = summaryEnv(base, rows, 'claude (ARVX47)');
  assert.ok(!('error' in picked) && picked.env.CLAUDE_CONFIG_DIR === '/h/.claude-arvx47' && picked.row === 'Claude (arvx47)');
  const first = summaryEnv(base, rows, '');
  assert.ok(!('error' in first) && first.env.CLAUDE_CONFIG_DIR === undefined && first.row === 'Claude (Sungage)', 'empty: the first Claude row, the default login');
  assert.ok(!('error' in first) && first.env.PATH === '/usr/bin');
  const wrong = summaryEnv(base, rows, 'Codex');
  assert.ok('error' in wrong && /"Codex" isn't a Claude row/.test(wrong.error) && /"Claude \(Sungage\)", "Claude \(arvx47\)"/.test(wrong.error));
  assert.strictEqual(base.CLAUDE_CONFIG_DIR, '/h/.claude-editor', "the editor's environment is left as it was");
  console.log('✓ which Claude login: a row by name, else the first; errors name the rows');

  // 8. Each pane's login: the account its running Claude Code is in (a sessions/<pid>.json record there, so a
  //    switch inside the pane follows), else the row it was started from, else the fallback; other agents: fallback.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-acc-'));
  const main = path.join(home, '.claude');
  const alt = path.join(home, '.claude-arvx47');
  const running = (dir: string, pid: number) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: 'x', cwd: '/r', name: 'Fix login' }));
  };
  running(main, 4001);
  running(alt, 4002);
  fs.writeFileSync(path.join(alt, 'sessions', '4003.json'), JSON.stringify({ pid: 9999 }));
  assert.strictEqual(accountOfProcess([3000, 4001], [main, alt]), main, "the shell's pid has no record; Claude's does");
  assert.strictEqual(accountOfProcess([4002], [main, alt]), alt);
  assert.strictEqual(accountOfProcess([4003], [main, alt]), undefined, 'a record for another pid');
  assert.strictEqual(accountOfProcess([0, 1, 5555], [main, alt]), undefined);
  const dirs = [{ dir: main, isDefault: true }, { dir: alt, isDefault: false }];
  const pane = { paneId: 'p', kind: 'claude', name: 'n', status: 'working', screen: '' };
  const env = (r: object, fb = '') => paneSummaryEnv({ ...pane, ...r }, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/editor' }, rows, dirs, fb);
  const switched = env({ pids: [4002], agentName: 'claude-sungage' });
  assert.ok(!('error' in switched) && switched.env.CLAUDE_CONFIG_DIR === alt, 'its running Claude wins over the name it was started with (a switch inside the pane)');
  const onDefault = env({ pids: [4001], agentName: 'claude-arvx47' });
  assert.ok(!('error' in onDefault) && onDefault.env.CLAUDE_CONFIG_DIR === undefined, 'the default account: no CLAUDE_CONFIG_DIR');
  const sluggy = [...rows.slice(0, 2), { ...rows[2], slug: 'claude-arvx47', plain: false } as unknown as AgentProfile];
  const byName = paneSummaryEnv({ ...pane, pids: [7777], agentName: 'claude-arvx47-2' }, {}, sluggy, dirs, '');
  assert.ok(!('error' in byName) && byName.env.CLAUDE_CONFIG_DIR === '/h/.claude-arvx47' && /started as Claude \(arvx47\)/.test(byName.why), 'no record: the row it was started from');
  const codex = env({ kind: 'codex', pids: [4002] }, 'Claude (arvx47)');
  assert.ok(!('error' in codex) && codex.env.CLAUDE_CONFIG_DIR === '/h/.claude-arvx47', 'another agent: the fallback setting');
  assert.ok('error' in env({ kind: 'codex' }, 'Nope'));
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✓ each pane's login: the account its Claude runs in, else the row it started from, else the fallback");

  // 9. The CLI call: our flags, the prompt on stdin (never in the arguments), the JSON result; errors reject.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sum-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `cat > "${dir}/stdin"`,
      `pwd > "${dir}/cwd"`,
      'if grep -q FAIL "' + dir + '/stdin"; then echo "not logged in" >&2; exit 1; fi',
      `printf '{"type":"result","is_error":false,"result":"Fixing it."}'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const work = path.join(dir, 'summaries');
  const req = { paneId: 'p', kind: 'claude', name: 'n', status: 'done', screen: '' };
  const run = claudeCliRunner(fake, work, () => process.env);
  assert.strictEqual(await run('SYSTEM TEXT', 'the screen', req), 'Fixing it.');
  const args = fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n');
  for (const want of ['-p', '--model', SUMMARY_MODEL, '--tools', '--strict-mcp-config', '--setting-sources', '--no-session-persistence', '--output-format', 'json', '--append-system-prompt', 'SYSTEM TEXT']) {
    assert.ok(args.includes(want), `passes ${want}`);
  }
  assert.strictEqual(args[args.indexOf('--tools') + 1], '', 'no tools');
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], '', 'no settings files (no hooks)');
  assert.ok(!args.includes('the screen'), 'the screen is not an argument');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'stdin'), 'utf8'), 'the screen');
  assert.strictEqual(fs.realpathSync(fs.readFileSync(path.join(dir, 'cwd'), 'utf8').trim()), fs.realpathSync(work), 'runs in its own folder');
  await assert.rejects(run('s', 'FAIL', req), /not logged in/);
  const noLogin = claudeCliRunner(fake, work, () => {
    throw new Error('no such row');
  });
  await assert.rejects(noLogin('s', 'x', req), /no such row/, "a login that can't be picked rejects");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ the claude CLI call: flags, prompt on stdin, own folder, JSON result, errors');
  console.log('\nsummaries tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
