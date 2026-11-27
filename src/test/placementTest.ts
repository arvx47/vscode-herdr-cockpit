// Which window a space opens in (src/windows/placement.ts), case by case.
import * as assert from 'assert';
import { decidePlacement, followsInto, insideFolders, PlaceFacts } from '../windows/placement';
import { sameRepoSpaces, Space } from '../state/model';

const base: PlaceFacts = { pane: false, mode: 'folder', ownWindow: false, openHere: false, mounted: false, otherWindow: false, hasFolders: true };
const cases: [string, Partial<PlaceFacts>, ReturnType<typeof decidePlacement>][] = [
  ['right-click Open in Its Own Window, already its window', { how: 'window', ownWindow: true }, 'here'],
  ['right-click Open in Its Own Window', { how: 'window' }, 'window'],
  ['right-click Add to This Window', { how: 'workspace', otherWindow: true }, 'add'],
  ['space open here, folder mode', { openHere: true, mounted: true }, 'add'],
  ['space open here, workspace mode, space clicked', { openHere: true, mounted: true, mode: 'workspace' }, 'here'],
  ['space open here, workspace mode, pane clicked', { openHere: true, mounted: true, mode: 'workspace', pane: true }, 'add'],
  ['tabs here but its folder moved, pane clicked', { openHere: true, mounted: false, pane: true }, 'stay'],
  ['its folder is inside one of ours, space clicked: its tabs here, nothing mounted', { openHere: true, mounted: false, insideFolder: true }, 'stay'],
  ['its folder is inside one of ours, workspace mode', { openHere: true, mounted: false, insideFolder: true, mode: 'workspace' }, 'stay'],
  ['another window has it', { otherWindow: true }, 'window'],
  ['another window has it, workspace mode', { otherWindow: true, mode: 'workspace' }, 'window'],
  ['workspace mode, nobody has it', { mode: 'workspace' }, 'askHub'],
  ['folder mode, window without folders', { hasFolders: false }, 'window'],
  ['folder mode, remembered: add here', { remembered: 'workspace' }, 'add'],
  ['folder mode, remembered: own window', { remembered: 'window' }, 'window'],
  ['folder mode, nothing remembered', {}, 'ask'],
  ['a session of this window, single-folder window: opens here, nothing mounted (a reload would end it)', { local: true }, 'stay'],
  ['a session of this window, window without folders', { local: true, hasFolders: false }, 'stay'],
  ['a session of this window, right-click Open in Its Own Window: still here', { local: true, how: 'window' }, 'stay'],
  ['a session of this window, workspace file: mounted at the end', { local: true, workspaceFile: true }, 'add'],
  ['a session of this window, workspace file, folder inside ours', { local: true, workspaceFile: true, openHere: true, insideFolder: true }, 'stay'],
  ['a session of this window, workspace mode', { local: true, mode: 'workspace', workspaceFile: true }, 'add'],
  ['a session of another window: opens in that window', { local: true, elsewhere: true }, 'window'],
  ['a session of another window, even with a workspace file here', { local: true, elsewhere: true, workspaceFile: true }, 'window'],
  ['groupWorktrees: its repository is open here', { repoHere: true }, 'add'],
  ['groupWorktrees: its repository is open here, over a remembered own window', { repoHere: true, remembered: 'window' }, 'add'],
  ['groupWorktrees: its repository is open in another window', { repoWindow: true }, 'repoWindow'],
  ['groupWorktrees: here wins over another window', { repoHere: true, repoWindow: true }, 'add'],
  ['groupWorktrees: its own window still wins', { repoHere: true, otherWindow: true }, 'window'],
  ['groupWorktrees: right-click Open in Its Own Window still wins', { repoHere: true, how: 'window' }, 'window'],
  ['groupWorktrees: workspace mode is one window anyway', { repoWindow: true, mode: 'workspace' }, 'askHub'],
];
for (const [what, facts, expected] of cases) {
  assert.strictEqual(decidePlacement({ ...base, ...facts }), expected, what);
}
console.log(`✓ placement: ${cases.length} cases`);

assert.strictEqual(followsInto({ otherWindow: true, mode: 'workspace', hub: true, mounted: true }), false, "another window's space stays there");
assert.strictEqual(followsInto({ otherWindow: false, mode: 'folder', hub: false, mounted: false }), false, "a space's own window doesn't follow elsewhere");
assert.strictEqual(followsInto({ otherWindow: false, mode: 'folder', hub: false, mounted: true }), true, 'into a space it has, it follows');
assert.strictEqual(followsInto({ otherWindow: false, mode: 'folder', hub: true, mounted: false }), true, 'the Cockpit window follows everywhere');
assert.strictEqual(followsInto({ otherWindow: false, mode: 'workspace', hub: false, mounted: false }), true, 'workspace mode follows');
console.log('✓ follow mode');

// A space whose shell cd'd into a subfolder still belongs to the window on the folder above it
assert.ok(insideFolders('/code/repo/src', ['/code/repo']));
assert.ok(insideFolders('/code/repo/a/b', ['/elsewhere', '/code/repo']));
assert.ok(!insideFolders('/code/repo', ['/code/repo']), 'the folder itself is "mounted", not inside');
assert.ok(insideFolders('/code/repo/..scratch', ['/code/repo']), 'a subfolder whose name starts with ..');
assert.ok(!insideFolders('/code/other', ['/code/repo']), 'a sibling is outside');
assert.ok(!insideFolders('/code/repo-2', ['/code/repo']), 'a sibling with the same prefix is not inside');
assert.ok(!insideFolders('/code', ['/code/repo']), 'a parent is not inside');
console.log('✓ spaces in a subfolder of this window');

console.log('\nplacement tests passed');

// herdr.groupWorktrees: which spaces are of the same repository
{
  const sp = (id: string, cwd: string, worktree?: Partial<NonNullable<Space['worktree']>>) => ({ id, label: id, cwd, worktree }) as unknown as Space;
  const app = sp('w1', '/r/app');
  const wtA = sp('w2', '/wt/app/a', { repo_key: '/r/app/.git', repo_root: '/r/app', is_linked_worktree: true });
  const wtB = sp('w3', '/wt/app/b', { repo_key: '/r/app/.git', repo_root: '/r/app', is_linked_worktree: true });
  const web = sp('w4', '/r/web', { repo_key: '/r/web/.git', repo_root: '/r/web', is_linked_worktree: false });
  const plain = sp('w5', '/notes');
  const all = [app, wtA, wtB, web, plain];
  assert.deepStrictEqual(sameRepoSpaces(all, wtA).map((s) => s.id), ['w1', 'w3'], 'the repo space (by its root) and the other worktree');
  assert.deepStrictEqual(sameRepoSpaces(all, app).map((s) => s.id), ['w2', 'w3'], "the repo space's worktrees");
  assert.deepStrictEqual(sameRepoSpaces(all, web).map((s) => s.id), [], 'a repo alone');
  assert.deepStrictEqual(sameRepoSpaces(all, plain).map((s) => s.id), [], 'not a repository');
  console.log('✓ spaces of the same repository');
}
