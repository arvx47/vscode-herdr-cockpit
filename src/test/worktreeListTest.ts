// Which worktrees Reopen Worktree… offers (src/commands/worktreeList.ts).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closedWorktrees, herdrWorktreeRepos, linkedWorktrees, worktreeLabel, worktreeListFolders } from '../commands/worktreeList';
import type { WorktreeInfo, WorktreeListResult } from '../drivers/herdr/herdrTypes';

const wt = (p: string, more: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path: p, branch: path.basename(p), is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: 'x', ...more,
});
const list = (repo: string, worktrees: WorktreeInfo[]): WorktreeListResult => ({
  type: 'worktree_list',
  source: { repo_key: `/r/${repo}/.git`, repo_name: repo, repo_root: `/r/${repo}`, source_checkout_path: `/r/${repo}` },
  worktrees,
});

// Only linked worktrees without a space, once each, by repo then name
const app = list('app', [
  wt('/r/app', { branch: 'main', is_linked_worktree: false, open_workspace_id: 'w1' }),
  wt('/wt/app/out-2'),
  wt('/wt/app/out-1', { branch: 'OUT-1' }),
  wt('/wt/app/open', { open_workspace_id: 'w4' }),
  wt('/wt/app/gone', { is_prunable: true }),
  wt('/wt/app/head', { branch: null, is_detached: true }),
]);
const found = closedWorktrees([list('web', [wt('/wt/web/a')]), app, app]);
assert.deepStrictEqual(found.map((w) => [w.repoName, worktreeLabel(w), w.repoFolder]), [
  ['app', 'head', '/r/app'],
  ['app', 'OUT-1', '/r/app'],
  ['app', 'out-2', '/r/app'],
  ['web', 'a', '/r/web'],
]);
assert.strictEqual(found[0].branch, undefined, 'a detached checkout is named after its folder');
console.log('✓ closed worktrees: linked, not open, not prunable, each once');

// Every linked worktree, the open ones with their space
const all = linkedWorktrees([app]);
assert.deepStrictEqual(all.map((w) => [worktreeLabel(w), w.spaceId]), [
  ['head', undefined],
  ['open', 'w4'],
  ['OUT-1', undefined],
  ['out-2', undefined],
]);
console.log('✓ linked worktrees: open ones too, with their space; not the repo itself or prunable ones');

// Folders to list: each repo once (by Herdr's repo key), plain folders, then Herdr's worktree folders not already there
assert.deepStrictEqual(
  worktreeListFolders(
    [
      { cwd: '/r/app', worktree: { repo_key: 'app' } },
      { cwd: '/wt/app/out-3', worktree: { repo_key: 'app' } },
      { cwd: '/r/plain' },
      { cwd: '/r/plain' },
      {},
    ],
    ['/wt/app/out-1', '/r/plain', '/wt/web/a'],
  ),
  ['/r/app', '/r/plain', '/wt/web/a'],
  "Herdr's folder of app is skipped: a space of app lives there",
);
const firsts = (h: string) => herdrWorktreeRepos(h).map((r) => r[0]);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hbwl-'));
assert.deepStrictEqual(firsts(home), [], 'no ~/.herdr/worktrees');
fs.mkdirSync(path.join(home, '.herdr/worktrees/app/out-2'), { recursive: true });
fs.mkdirSync(path.join(home, '.herdr/worktrees/app/out-1'), { recursive: true });
fs.mkdirSync(path.join(home, '.herdr/worktrees/empty'), { recursive: true });
fs.writeFileSync(path.join(home, '.herdr/worktrees/stray.txt'), '');
assert.deepStrictEqual(firsts(home), [path.join(home, '.herdr/worktrees/app/out-1')], 'one checkout per repo folder first');
assert.deepStrictEqual(
  herdrWorktreeRepos(home),
  [[path.join(home, '.herdr/worktrees/app/out-1'), path.join(home, '.herdr/worktrees/app/out-2')]],
  "each repo's checkouts, to try in turn",
);
fs.rmSync(home, { recursive: true, force: true });
console.log('✓ worktree list folders: spaces per repo, then Herdr\'s worktree folders');
