// Find in a built-in Herdr tab (termFind.ts), file links (termLinks.ts) and the screen pieces they use
// (highlights, the find bar, Option+click, Shift+click, typing over a selection). No VS Code, no Herdr.
import * as assert from 'assert';
import { charWidth, compileQuery, findMatches, layout, offsetFor, PaneText, startAt } from '../drivers/herdr/termFind';
import { findFileRefs } from '../terminal/termLinks';
import { Screen } from '../drivers/herdr/termScreen';

(async () => {
  // ---------- widths and wrapping ----------
  assert.deepStrictEqual(['a', '日', '😀', '́', '●', '⏵'].map(charWidth), [1, 2, 2, 0, 1, 1]);
  const lay = layout('abcdefgh日本', 5); // abcde | fgh + 日 doesn't fit (needs 2 of 2 left: fits) | 本
  assert.strictEqual(lay.rows, 3);
  assert.deepStrictEqual([lay.at(5), lay.at(8), lay.at(9)], [{ row: 1, col: 0 }, { row: 1, col: 3 }, { row: 2, col: 0 }]);
  assert.strictEqual(layout('', 80).rows, 1, 'an empty line is a row');
  assert.strictEqual(layout('x'.repeat(80), 80).rows, 1, 'exactly the width: one row');
  console.log('✓ find: character widths, lines wrapped at the pane width');

  // ---------- queries ----------
  const q = (s: string) => compileQuery(s) as RegExp;
  assert.strictEqual(compileQuery(''), undefined);
  assert.ok(q('error').flags.includes('i'), 'lower case: case-insensitive');
  assert.ok(!q('Error').flags.includes('i'), 'a capital: case-sensitive');
  assert.strictEqual(q('a.b(').source, 'a\\.b\\(', 'literal by default');
  assert.ok(q('/\\S+ed$/').flags.includes('i'), 'regex escapes are not capitals');
  assert.ok(!q('/Fail.*/').flags.includes('i'));
  assert.ok(q('/fail/i').flags.includes('i'));
  assert.ok(compileQuery('/(/') instanceof Error, 'a bad regex is an error');
  console.log('✓ find: smart case, literal or /regex/, bad regex reported');

  // ---------- matches over the history ----------
  const text = new PaneText(['first error here', 'x'.repeat(8) + 'ERROR', '', 'no', 'error error'], 10);
  assert.deepStrictEqual(text.starts, [0, 2, 4, 5, 6], 'wrapped lines take two rows');
  const ms = findMatches(text, q('error'));
  assert.deepStrictEqual(ms.map((m) => [m.row, m.spans]), [
    [0, [{ row: 0, from: 6, to: 10 }, { row: 1, from: 0, to: 1 }]], // "error" across the wrap of line 0
    [2, [{ row: 2, from: 8, to: 10 }, { row: 3, from: 0, to: 3 }]],
    [6, [{ row: 6, from: 0, to: 5 }]],
    [6, [{ row: 6, from: 6, to: 10 }, { row: 7, from: 0, to: 1 }]],
  ]);
  assert.strictEqual(findMatches(text, q('Error')).length, 0, 'case-sensitive with a capital');
  assert.strictEqual(findMatches(new PaneText(['aaa'], 80), q('/a*/')).length, 1, 'no empty matches, no endless loop');
  assert.strictEqual(startAt(ms, 5), 1, 'starts at the newest match at or above the view bottom');
  assert.strictEqual(startAt(ms, 100), 3);
  // offsets: the history has max+rows rows; the top row is max - offset.
  assert.strictEqual(offsetFor(3000, 3012, 40), 3012 - (3000 - 19), 'the row lands in the middle');
  assert.strictEqual(offsetFor(5, 3012, 40), 3012, 'clamped at the top');
  assert.strictEqual(offsetFor(3050, 3012, 40), 0, 'clamped at the bottom');
  console.log('✓ find: matches across wrapped rows, newest first, centered offsets');

  // ---------- file references ----------
  const refs = (s: string) => findFileRefs(s).map((r) => [s.substr(r.start, r.length), r.path, r.line, r.col]);
  assert.deepStrictEqual(refs('Edited src/termFind.ts:42:7 and ./a/b.py(12, 3), see README.md.'), [
    ['src/termFind.ts:42:7', 'src/termFind.ts', 42, 7],
    ['./a/b.py(12, 3)', './a/b.py', 12, 3],
    ['README.md', 'README.md', undefined, undefined],
  ]);
  assert.deepStrictEqual(refs('v1.2.3 and https://github.com/a/b.ts e.g. foo'), [], 'versions, URLs, abbreviations are not files');
  assert.deepStrictEqual(refs('at /abs/x.ts#L9 ~/notes/todo'), [
    ['/abs/x.ts#L9', '/abs/x.ts', 9, undefined],
    ['~/notes/todo', '~/notes/todo', undefined, undefined],
  ]);
  console.log('✓ links: path:line:col, (line, col), #L, home and relative paths; not versions or URLs');

  // ---------- screen: highlights and the find bar ----------
  const s = new Screen(20, 3);
  await s.write('one error two');
  s.setMarks([{ y: 0, from: 4, to: 9, current: true }, { y: 1, from: 0, to: 2, current: false }]);
  const p = s.paint([0]);
  assert.ok(p.includes('\x1b[0;1;30;48;5;208merror'), `the current match is highlighted: ${JSON.stringify(p)}`);
  const bar = s.findBar('err', '1 of 3', '↑↓ ↵ · Esc');
  assert.ok(bar.includes('\x1b[1;') && bar.includes(' Find: err▏ 1 of 3 ') && bar.endsWith('\x1b8\x1b[?2026l'), `bar on the top row: ${JSON.stringify(bar)}`);
  assert.deepStrictEqual(s.rowText(0).text.trimEnd(), 'one error two');
  console.log('✓ screen: find highlights (current one stronger), the find bar');

  // ---------- Option+click, Shift+click, typing over a selection ----------
  const input = new Screen(30, 3);
  await input.write('$ echo hello world'); // cursor at 18
  assert.strictEqual(input.moveKeys(7, 0), '\x1b[D'.repeat(11), 'Option+click on "hello": 11 left');
  assert.strictEqual(input.moveKeys(25, 0), undefined, 'past the end of the input: already there');
  assert.strictEqual(input.moveKeys(3, 1), undefined, 'not the cursor row');
  await input.write('\x1b[1;3H');
  assert.strictEqual(input.moveKeys(7, 0), '\x1b[C'.repeat(5), 'to the right of the cursor');
  input.mouse({ x: 2, y: 0, release: false, motion: false }, 0);
  input.mouse({ x: 5, y: 0, release: false, motion: true }, 0);
  input.mouse({ x: 5, y: 0, release: true, motion: false }, 0);
  const ext = input.mouse({ x: 11, y: 0, release: false, motion: false, shift: true }, 1000);
  assert.deepStrictEqual(ext.repaint, [0]);
  assert.strictEqual(input.mouse({ x: 11, y: 0, release: true, motion: false }, 1000).copy, 'echo hello', 'Shift+click extends the selection');
  console.log('✓ screen: Option+click moves the cursor, Shift+click extends the selection');

  console.log('\nfind tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
