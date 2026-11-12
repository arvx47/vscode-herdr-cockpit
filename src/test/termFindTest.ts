// The find bar's controller (termFindController.ts) against a fake Herdr, the line layout it relies on
// (termFind.ts), the screen's selection repaint and kept rows (termScreen.ts), and stopping a stream's process
// after Herdr closed it (herdrStream.ts). No VS Code, no Herdr.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HerdrStream } from '../herdrStream';
import { charWidth, layout } from '../termFind';
import { FindController, PaneScroll } from '../termFindController';
import { Screen } from '../termScreen';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The layout before it stored only where lines wrap: one position per UTF-16 index. */
function referenceLayout(line: string, cols: number) {
  const pos: { row: number; col: number }[] = [];
  let row = 0;
  let col = 0;
  for (let i = 0; i < line.length; ) {
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = charWidth(ch);
    if (w > 0 && col + w > cols) {
      row++;
      col = 0;
    }
    for (let k = 0; k < ch.length; k++) {
      pos[i + k] = { row, col };
    }
    col += w;
    i += ch.length;
  }
  const end = { row, col };
  return { rows: row + 1, at: (index: number) => pos[index] ?? end };
}

(async () => {
  // ---------- layout: same answers as one position per character ----------
  const alphabet = ['a', 'b', ' ', '日', '😀', '́', '​', 'é', 'x'];
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let t = 0; t < 400; t++) {
    let line = '';
    const len = rand(40);
    for (let i = 0; i < len; i++) {
      line += alphabet[rand(alphabet.length)];
    }
    const cols = 1 + rand(12);
    const got = layout(line, cols);
    const want = referenceLayout(line, cols);
    assert.strictEqual(got.rows, want.rows, `rows of ${JSON.stringify(line)} at ${cols}`);
    for (let i = -1; i <= line.length + 1; i++) {
      assert.deepStrictEqual(got.at(i), want.at(i), `at(${i}) of ${JSON.stringify(line)} at ${cols}`);
    }
  }
  const tiny = layout('日', 1);
  assert.deepStrictEqual([tiny.rows, tiny.at(0)], [2, { row: 1, col: 0 }], 'a wide character wider than the pane starts a row of its own');
  console.log('✓ layout: only line breaks stored, positions identical to one per character (fuzzed, wide, emoji, combining)');

  // ---------- screen: painting the selection and the find highlights once per row ----------
  const s = new Screen(10, 3);
  await s.write('abcdefghij\r\nklmnopqrst\r\nuvwxyz');
  s.mouse({ x: 7, y: 0, release: false, motion: false }, 0);
  s.mouse({ x: 2, y: 1, release: false, motion: true }, 0);
  s.setMarks([{ y: 1, from: 4, to: 7, current: false }, { y: 1, from: 5, to: 6, current: true }, { y: 9, from: 0, to: 1, current: true }]);
  const p = s.paint([0, 1, 2]);
  assert.ok(p.includes('\x1b[0mabcdefg\x1b[0;7mhij'), `row 0 selected from column 7: ${JSON.stringify(p)}`);
  assert.ok(p.includes('\x1b[0;7mklm\x1b[0mn\x1b[0;30;43mo\x1b[0;1;30;48;5;208mp\x1b[0;30;43mq\x1b[0mrst'), `row 1: selection to column 2, then the marks: ${JSON.stringify(p)}`);
  assert.ok(p.includes('\x1b[3;1H\x1b[0muvwxyz'), 'row 2 untouched');
  // A frame at offset 0 changes a selected row: the copy has what's on screen now.
  await s.write('\x1b[1;1HABCDEFGHIJ');
  assert.strictEqual(s.mouse({ x: 2, y: 1, release: true, motion: false }, 0).copy, 'HIJ\nklm', 'the copy reads the rows on screen');
  console.log('✓ screen: selection and find highlights painted per row; a copy at offset 0 has the latest text');

  // ---------- screen: rows kept while they scroll away, with wide characters ----------
  const tall = new Screen(12, 4);
  const view = (top: number) => `\x1b[2J\x1b[H${[0, 1, 2, 3].map((i) => `日${top + i}本`).join('\r\n')}`;
  await tall.write(view(10));
  tall.mouse({ x: 0, y: 2, release: false, motion: false }, 0);
  tall.mouse({ x: 0, y: 0, release: false, motion: true }, 0);
  tall.scrollSent('up', 2);
  assert.strictEqual(await tall.write(view(8)), 2);
  assert.strictEqual(tall.mouse({ x: 0, y: 0, release: true, motion: false }, 0).copy, '日8本\n日9本\n日10本\n日11本\n日', 'wide characters copied once from kept rows');
  console.log('✓ screen: kept rows with wide characters copy correctly');

  // ---------- the find controller, against a fake Herdr ----------
  const lines = Array.from({ length: 30 }, (_, i) => {
    if (i % 10 === 3) {
      return `line ${i} err`;
    }
    return `line ${i}`;
  });
  const view0: PaneScroll = { offset_from_bottom: 0, max_offset_from_bottom: 25, viewport_rows: 5 };
  const herdr = { rev: 1, reads: 0, scrolls: [] as number[], view: { ...view0 } };
  const screen = new Screen(20, 5);
  await screen.write('line 25\r\nline 26\r\nline 27\r\nline 28\r\nline 29');
  let written = '';
  let listed = 0;
  const logs: string[] = [];
  const finder = new FindController({
    screen: () => screen,
    request: async <T>(method: string, params: any): Promise<T> => {
      if (method === 'pane.copy_motion') {
        return { content_revision: herdr.rev } as T;
      }
      if (method === 'pane.get') {
        return { pane: { scroll: { ...herdr.view } } } as T;
      }
      if (method === 'pane.selection.read') {
        herdr.reads++;
        assert.strictEqual(params.cursor.col, screen.cols - 1, 'reads up to the last column of the tab');
        return { text: lines.join('\n') } as T;
      }
      if (method === 'pane.scroll') {
        herdr.scrolls.push(params.offset_from_bottom);
        herdr.view.offset_from_bottom = params.offset_from_bottom;
        return { pane: { scroll: { ...herdr.view } } } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    write: (data) => (written += data),
    log: (line) => logs.push(line),
    showList: () => listed++,
  });
  finder.open();
  assert.ok(finder.active && written.includes(' Find: ▏'), 'the bar opens empty');
  finder.key('err');
  await sleep(200);
  assert.strictEqual(herdr.reads, 1, 'the history is read once for the query');
  assert.deepStrictEqual(herdr.scrolls, [4], 'starts at the newest match (row 23), in the middle of the view');
  assert.ok(written.includes('3 of 3'), 'the bar counts the matches');

  // Enter: the older match. The pane changed, but the text was read less than a second ago: no re-read yet.
  herdr.rev = 2;
  finder.key('\r');
  await sleep(50);
  assert.deepStrictEqual(herdr.scrolls, [4, 14], 'Enter goes to the older match (row 13)');
  assert.ok(written.includes('2 of 3'));
  finder.key('\r');
  await sleep(50);
  assert.strictEqual(herdr.reads, 1, 'moving quickly between matches does not re-read the history');
  await sleep(1100);
  assert.strictEqual(herdr.reads, 2, 'a second later, the changed pane is read again');

  // Same revision, but the tab got wider: the lines wrap differently, so the history is read again.
  screen.resize(30, 5);
  finder.key('\x7f');
  await sleep(200);
  assert.strictEqual(herdr.reads, 3, 'a new width reads the history again');
  finder.key('r');
  await sleep(200);
  assert.strictEqual(herdr.reads, 3, 'same revision and width: the text is reused');

  // Tab lists the matches; jumping from the list scrolls there.
  finder.key('\t');
  assert.strictEqual(listed, 1);
  const list = finder.list(2)!;
  assert.deepStrictEqual([list.total, list.items.map((i) => i.row), list.items[0].label], [3, [3, 13], 'line 3 err']);
  list.jump(0);
  await sleep(50);
  assert.strictEqual(herdr.scrolls[herdr.scrolls.length - 1], 24, 'the list jumps to row 3, in the middle of the view');

  // Escape closes it; a stale jump from the list does nothing.
  finder.key('\x1bxyz');
  assert.ok(!finder.active, 'Escape closes the bar');
  const before = herdr.scrolls.length;
  list.jump(1);
  await sleep(50);
  assert.strictEqual(herdr.scrolls.length, before, 'the closed bar does not move the view');
  finder.open();
  assert.ok(written.endsWith('\x1b8\x1b[?2026l') && written.includes(' Find: err▏'), 'the last query is offered again');
  finder.dispose();
  assert.ok(!finder.active);
  assert.deepStrictEqual(logs, []);
  screen.dispose();
  console.log('✓ find controller: query, Enter, history re-read at most once a second, and again for a new width; list, Esc');

  // ---------- stream: the process is stopped even after Herdr closed the stream ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-find-'));
  const pidFile = path.join(dir, 'pid');
  const fake = path.join(dir, 'herdr');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({ type: 'terminal.closed', reason: 'pane closed' }));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  let closed: { reason?: string } | undefined;
  const st = new HerdrStream(fake, 'w1:p1', { cols: 80, rows: 24 }, process.env, { onFrame: () => {}, onClose: (i) => (closed = i) }, 'observe');
  for (let i = 0; i < 100 && !(closed && fs.existsSync(pidFile)); i++) {
    await sleep(20);
  }
  assert.deepStrictEqual(closed, { reason: 'pane closed' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  st.release();
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    await sleep(20);
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.ok(!alive, 'release stops the process after terminal.closed');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ stream: release stops a process whose stream Herdr already closed');

  console.log('\nterminal find tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
