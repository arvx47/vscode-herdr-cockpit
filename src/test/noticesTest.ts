// Notification wording (src/notices.ts) and the folders a file link opens from without asking (src/linkRoots.ts).
import * as assert from 'assert';
import * as path from 'path';
import { fileReference, lostNotice, nameList, takenOverNotice } from '../notices';
import { shellTabName } from '../viewState';
import { fileLinkRoots } from '../linkRoots';
import { branchFromInput, branchProblem } from '../branchName';

// Losing Herdr: a stopped server offers to start it, a broken connection to retry
assert.deepStrictEqual(lostNotice('crashed').actions, ['Start Herdr', 'Open Herdr TUI']);
assert.deepStrictEqual(lostNotice('not-running').actions, ['Start Herdr', 'Open Herdr TUI']);
assert.deepStrictEqual(lostNotice('unreachable', 'timed out'), { message: 'Lost the connection to Herdr: timed out.', actions: ['Retry'] });
assert.strictEqual(lostNotice('unreachable').message, 'Lost the connection to Herdr.');
console.log('✓ lost Herdr: message and actions per reason');

// Taken-over panes, said once for the ones lost together
assert.strictEqual(nameList(['a']), 'a');
assert.strictEqual(nameList(['a', 'b', 'c']), 'a, b and c');
assert.strictEqual(nameList(['a', 'b', 'c', 'd', 'e']), 'a, b and 3 more');
assert.strictEqual(
  takenOverNotice([{ name: 'Claude', who: 'Kiro' }]),
  'Kiro took over the Herdr pane Claude. Its tab shows it read-only here; type in a tab to take it back.',
);
assert.strictEqual(
  takenOverNotice([{ name: 'Claude' }, { name: 'Tab 1' }]),
  'Another Herdr client took over the Herdr panes Claude and Tab 1. Their tabs show them read-only here; type in a tab to take it back.',
);
assert.ok(takenOverNotice([{ name: 'a', who: 'Kiro' }, { name: 'b' }]).startsWith('Other Herdr clients took over'));
console.log('✓ taken-over panes: who and which, in one line');

// Link roots: not /, home or above it, nor a hidden folder in home (Herdr's own ~/.herdr stays)
const home = path.join(path.sep, 'home', 'someone');
const roots = fileLinkRoots(
  [
    path.sep,
    home,
    path.dirname(home),
    path.join(home, '.ssh'),
    path.join(home, '.aws', 'sso'),
    path.join(home, '.herdr', 'worktrees', 'repo', 'branch'),
    path.join(home, 'code', 'repo'),
    path.join(home, 'code', 'repo') + path.sep,
    undefined,
    path.join(path.sep, 'srv', 'project'),
  ],
  home,
);
assert.deepStrictEqual(roots, [path.join(home, '.herdr', 'worktrees', 'repo', 'branch'), path.join(home, 'code', 'repo'), path.join(path.sep, 'srv', 'project')]);
console.log('✓ file links: only project folders count as safe roots');

// Send to Agent: the file relative to the agent's folder, with the selected lines
const sel = (startLine: number, endLine: number, endChar: number) => ({ isEmpty: false, start: { line: startLine }, end: { line: endLine, character: endChar } });
const repo = path.join(path.sep, 'work', 'repo');
const file = path.join(repo, 'src', 'app.ts');
assert.strictEqual(fileReference(file, { isEmpty: true, start: { line: 0 }, end: { line: 0, character: 0 } }, repo), path.join('src', 'app.ts'));
assert.strictEqual(fileReference(file, sel(11, 29, 4), repo), `${path.join('src', 'app.ts')}:12-30`);
// A selection ending at the start of a line doesn't include that line
assert.strictEqual(fileReference(file, sel(11, 12, 0), repo), `${path.join('src', 'app.ts')}:12`);
// Outside the agent's folder: the full path
assert.strictEqual(fileReference(file, sel(0, 0, 3), path.join(path.sep, 'elsewhere')), `${file}:1`);
console.log('✓ file references: relative path and selected lines');

// Shells named after Herdr's numbered tabs
assert.strictEqual(shellTabName('2'), 'Tab 2');
assert.strictEqual(shellTabName('build'), 'build');
console.log('✓ shell tab names');

// New worktree: a ticket key, its link, or any branch name
assert.strictEqual(branchFromInput('  OUT-9656 '), 'OUT-9656');
assert.strictEqual(branchFromInput('https://example.atlassian.net/browse/OUT-9656'), 'OUT-9656');
assert.strictEqual(branchFromInput('https://example.atlassian.net/browse/OUT-9656?focusedCommentId=1'), 'OUT-9656');
assert.strictEqual(branchFromInput('feat/rate-limit'), 'feat/rate-limit');
assert.strictEqual(branchProblem('OUT-9656'), undefined);
assert.strictEqual(branchProblem('feat/rate-limit'), undefined);
for (const bad of ['', 'two words', 'a..b', '-x', 'x/', 'x.lock', 'a//b', 'x:y', '.hidden', '@']) {
  assert.ok(branchProblem(bad), `rejects "${bad}"`);
}
console.log('✓ worktree branch names from keys and links');

console.log('\nnotices tests passed');
