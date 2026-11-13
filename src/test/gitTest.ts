import * as assert from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filterOverrides, gitEnv, gitInfo, hasChanges, mainBranch, parseStatus } from '../gitInfo';

// Parser: staged / modified / untracked / conflicts / upstream / ahead-behind.
const p = parseStatus(
  ['## feat/x...origin/feat/x [ahead 2, behind 1]', 'M  staged.ts', ' M modified.ts', 'MM both.ts', 'A  added.ts', '?? new.txt', 'UU conflict.ts', ''].join('\n'),
);
assert.deepStrictEqual(
  { ...p },
  { branch: 'feat/x', upstream: 'origin/feat/x', detached: false, ahead: 2, behind: 1, staged: 3, modified: 2, untracked: 1, conflicts: 1, changes: 6 },
);
assert.deepStrictEqual([parseStatus('## main\n').branch, parseStatus('## main\n').upstream], ['main', undefined]);
assert.strictEqual(parseStatus('## HEAD (no branch)\n').branch, 'detached HEAD');
assert.strictEqual(parseStatus('## No commits yet on main\n').branch, 'main');
console.log('✓ git status parsing');

// Real repo: branch, counts and last commit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-'));
execSync('git init -q -b main && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); fs.writeFileSync(path.join(dir, 'b.txt'), 'y');
// A repository's core.fsmonitor command must never run (it would execute on every refresh).
const marker = path.join(dir, '..', `fsmonitor-ran-${process.pid}`);
fs.writeFileSync(path.join(dir, 'hook.sh'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
execSync(`git config core.fsmonitor "${path.join(dir, 'hook.sh')}"`, { cwd: dir });
// Nor may a clean filter the repo's config defines (status runs it for recently touched files).
const filterMarker = path.join(dir, '..', `filter-ran-${process.pid}`);
fs.writeFileSync(path.join(dir, 'filter.sh'), `#!/bin/sh\ntouch "${filterMarker}"\ncat\n`, { mode: 0o755 });
fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil\n');
// A tracked file changed after commit: status passes it through the clean filter.
fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
execSync('git -c filter.evil.clean=cat add tracked.txt .gitattributes && git -c user.email=a@b -c user.name=t -c filter.evil.clean=cat commit -q -m tracked', { cwd: dir });
execSync(`git config filter.evil.clean "${path.join(dir, 'filter.sh')}"`, { cwd: dir });
// Same size, new content: git must hash the file, which runs it through the clean filter.
fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n');
// Prove the setup reaches the vulnerable path: plain git status DOES run the repo's filter.
execSync('git -c core.fsmonitor=false status --porcelain', { cwd: dir });
assert.ok(fs.existsSync(filterMarker), 'test setup: plain git status should run the filter');
// Only what the sidebar's git calls do counts from here on (the setup's own git commands may have run the hooks).
fs.rmSync(filterMarker, { force: true });
fs.rmSync(marker, { force: true });
gitInfo(dir, () => {
  assert.ok(!fs.existsSync(marker), 'core.fsmonitor from the repo config was executed');
  assert.ok(!fs.existsSync(filterMarker), 'a filter from the repo config was executed');
  const info = gitInfo(dir, () => {})!;
  assert.strictEqual(info.branch, 'main'); assert.strictEqual(info.changes, 5); assert.strictEqual(info.untracked, 4); assert.strictEqual(info.modified, 1);
  assert.strictEqual(info.lastCommit?.subject, 'tracked');
  assert.strictEqual(gitInfo('/definitely/not/here', () => {}), undefined);
  console.log('✓ git branch + change count; repo fsmonitor/filter commands not executed');
  failClosed().then(envScrubbed).then(mainBranches).then(changesToReview).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
});
setTimeout(() => { console.error('git test timed out'); process.exit(1); }, 4000);

// Filter discovery must fail closed: if the repo's config can't be read, or a filter can't be switched off,
// git doesn't run for that folder at all. (Global/system config off, so the user's own setup can't interfere:
// GIT_CONFIG_GLOBAL would be scrubbed from git's environment, so an empty HOME stands in for it.)
async function failClosed() {
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-home-'));
  process.env.XDG_CONFIG_HOME = path.join(process.env.HOME, '.config');
  assert.strictEqual(await filterOverrides('/definitely/not/here'), undefined, 'unreadable config: fail closed');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-plain-'));
  execSync('git init -q -b main', { cwd: plain });
  assert.deepStrictEqual(await filterOverrides(plain), [], 'no filters (git config exit 1): proceed with no overrides');
  execSync(`git config "filter.we=ird.clean" cat`, { cwd: plain });
  assert.strictEqual(await filterOverrides(plain), undefined, 'a driver name that -c cannot express: fail closed');
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-evil-'));
  execSync('git init -q -b main && git config filter.x.clean cat', { cwd: evil });
  assert.deepStrictEqual(await filterOverrides(evil), ['-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=', '-c', 'filter.x.required=false']);
  console.log('✓ filter discovery fails closed');
}

// The extension host's GIT_* variables never reach git: GIT_DIR pointing at another repository, and config
// injected through GIT_CONFIG_COUNT/KEY/VALUE (here a core.fsmonitor command that would leave a marker).
async function envScrubbed() {
  assert.deepStrictEqual(
    gitEnv({ PATH: '/bin', GIT_DIR: '/x/.git', GIT_EXTERNAL_DIFF: 'evil', git_ssh_command: 'evil', GIT_CONFIG_NOSYSTEM: '1', HOME: '/h' }),
    { PATH: '/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/h' },
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-env-'));
  execSync('git init -q -b mine && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m mine', { cwd: repo });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-elsewhere-'));
  execSync('git init -q -b elsewhere && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m elsewhere', { cwd: elsewhere });
  const envMarker = path.join(repo, '..', `env-fsmonitor-ran-${process.pid}`);
  const hook = path.join(elsewhere, 'hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${envMarker}"\n`, { mode: 0o755 });
  const injected = { GIT_DIR: path.join(elsewhere, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: hook };
  Object.assign(process.env, injected);
  try {
    const info = await new Promise<ReturnType<typeof gitInfo>>((resolve) => {
      gitInfo(repo, () => resolve(gitInfo(repo, () => {})));
    });
    assert.strictEqual(info?.branch, 'mine', 'GIT_DIR from the environment was used');
    assert.strictEqual(info?.lastCommit?.subject, 'mine');
    assert.ok(!fs.existsSync(envMarker), 'config from GIT_CONFIG_* in the environment was applied');
  } finally {
    for (const k of Object.keys(injected)) {
      delete process.env[k];
    }
  }
  console.log('✓ GIT_* variables from the extension host are not passed to git');
}

// New worktrees start from the repo's main branch (a local one, so the new branch tracks nothing): the one
// origin/HEAD names, else main or master, whatever branch the repo is on.
async function mainBranches() {
  const commit = '-c user.email=a@b -c user.name=t commit -q --allow-empty -m x';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-main-'));
  execSync(`git init -q -b master && git ${commit} && git checkout -q -b feature`, { cwd: repo });
  assert.strictEqual(await mainBranch(repo), 'master', 'no remote: a local master');
  execSync(`git branch trunk && git update-ref refs/remotes/origin/trunk HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk`, { cwd: repo });
  assert.strictEqual(await mainBranch(repo), 'trunk', "origin/HEAD's branch first");
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-none-'));
  execSync(`git init -q -b dev && git ${commit}`, { cwd: none });
  assert.strictEqual(await mainBranch(none), undefined, 'no main branch to find');
  console.log('✓ the main branch new worktrees start from');
}

// The done notification offers Review changes only when there's something to review.
async function changesToReview() {
  const commit = '-c user.email=a@b -c user.name=t commit -q --allow-empty -m x';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-review-'));
  execSync(`git init -q -b main && git ${commit}`, { cwd: repo });
  assert.strictEqual(await hasChanges(repo, false), false, 'a clean repo: nothing to review');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  assert.strictEqual(await hasChanges(repo, false), true, 'a new file counts');
  fs.rmSync(path.join(repo, 'new.txt'));
  // A worktree's branch with a commit of its own: something to review even with a clean working tree.
  execSync(`git checkout -q -b ticket && git ${commit}`, { cwd: repo });
  assert.strictEqual(await hasChanges(repo, false), false, 'outside a worktree only uncommitted changes count');
  assert.strictEqual(await hasChanges(repo, true), true, "a worktree branch's commits count");
  execSync('git checkout -q main', { cwd: repo });
  assert.strictEqual(await hasChanges(repo, true), false, 'the main branch itself: nothing since it');
  assert.strictEqual(await hasChanges(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-norepo-')), false), undefined, 'not a repository');
  console.log('✓ whether there are changes to review');
}
