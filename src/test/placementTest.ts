// Which window a space opens in (src/placement.ts), case by case.
import * as assert from 'assert';
import { decidePlacement, followsInto, insideFolders, PlaceFacts } from '../placement';

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
assert.ok(!insideFolders('/code/repo-2', ['/code/repo']), 'a sibling with the same prefix is not inside');
assert.ok(!insideFolders('/code', ['/code/repo']), 'a parent is not inside');
console.log('✓ spaces in a subfolder of this window');

console.log('\nplacement tests passed');
