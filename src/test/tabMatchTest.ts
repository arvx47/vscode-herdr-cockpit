// Matching editor tabs to our terminals (src/tabMatch.ts) and the moves that put them back in order.
import * as assert from 'assert';
import { matchTabs, nextMove, TabRef } from '../tabMatch';

const tabs = (labels: string[], column = 1): TabRef<string>[] => labels.map((label, index) => ({ tab: `${column}:${index}`, label, column, index }));
const none = () => undefined;

// By name, same names in the order the terminals opened
const panes = [
  { paneId: 'a', name: 'Herdr: Tab 1' },
  { paneId: 'b', name: 'Herdr: Claude' },
  { paneId: 'c', name: 'Herdr: Tab 1' },
];
const bar = tabs(['Herdr: Tab 1', 'file.ts', 'Herdr: Claude', 'Herdr: Tab 1']);
assert.deepStrictEqual(matchTabs(bar, panes, none).map((t) => t.paneId), ['a', 'b', 'c']);
console.log('✓ tabs matched by name, same names in opening order');

// A tab tied to a pane wins over the name order: two same-named tabs swapped are told apart
const tied = new Map([['1:0', 'c'], ['1:3', 'a']]);
assert.deepStrictEqual(matchTabs(bar, panes, (t) => tied.get(t)).map((t) => t.paneId), ['c', 'b', 'a']);
// A tie to a pane that's gone (or one already used) is ignored, and the tab falls back to its name
assert.deepStrictEqual(matchTabs(bar, panes, (t) => (t === '1:0' ? 'gone' : undefined)).map((t) => t.paneId), ['a', 'b', 'c']);
console.log('✓ tabs tied to a pane are matched for sure');

// Tabs that match nothing (other terminals, a name changed meanwhile) are left out
assert.deepStrictEqual(matchTabs(tabs(['zsh', 'Herdr: Claude']), panes, none).map((t) => t.paneId), ['b']);
console.log('✓ other terminals are left out');

// nextMove: the first slot holding the wrong tab, keeping the slots our tabs take (a file tab in between stays)
const rank = (order: string[]) => (id: string) => order.indexOf(id);
const matched = matchTabs(bar, panes, none);
assert.strictEqual(nextMove(matched, rank(['a', 'b', 'c'])), undefined, 'already in order');
const m = nextMove(matched, rank(['c', 'a', 'b']))!;
assert.deepStrictEqual([m.tab.paneId, m.to], ['c', 0], 'c goes to the first slot');
// Simulate moves until sorted: never more than the number of tabs
let state = matched.map((t) => ({ paneId: t.paneId, index: t.index }));
const target = rank(['c', 'b', 'a']);
let moves = 0;
for (let mv = nextMove(state, target); mv; mv = nextMove(state, target)) {
  const slots = state.map((t) => t.index);
  const order = state.map((t) => t.paneId).filter((id) => id !== mv!.tab.paneId);
  order.splice(slots.indexOf(mv.to), 0, mv.tab.paneId);
  state = order.map((paneId, i) => ({ paneId, index: slots[i] }));
  moves++;
  assert.ok(moves <= 3, 'converges');
}
assert.deepStrictEqual(state.map((t) => t.paneId), ['c', 'b', 'a']);
console.log('✓ moves put the tabs in order within their slots');

console.log('\ntab match tests passed');
