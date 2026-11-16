// The built-in terminal's pieces without VS Code: mouse/keystroke parsing, selection and painting on a
// headless screen, and the `herdr terminal session control` client against a fake herdr.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HerdrStream, isTakenOver } from '../drivers/herdr/herdrStream';
import { parseInput, Screen } from '../drivers/herdr/termScreen';

(async () => {
  // ---------- input ----------
  assert.deepStrictEqual(parseInput('ls\r'), [{ kind: 'data', text: 'ls\r' }]);
  const t = parseInput('a\x1b[<0;5;2M\x1b[<32;9;3M\x1b[<0;9;3mb\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<4;2;2M');
  assert.deepStrictEqual(
    t.map((x) => (x.kind === 'data' ? x.text : `${x.wheel ?? (x.release ? 'up' : x.motion ? 'drag' : 'down')}@${x.x},${x.y}${x.shift ? '+shift' : ''}`)),
    ['a', 'down@4,1', 'drag@8,2', 'up@8,2', 'b', 'up@0,0', 'down@0,0', 'down@1,1+shift'],
  );
  console.log('✓ input: keystrokes and SGR mouse reports (press, drag, release, wheel, modifiers)');

  // ---------- selection ----------
  const s = new Screen(20, 5);
  await s.write('hello world\r\nsecond line here\r\nabcdefghijklmnopqrstuvwxyz'); // the last one wraps at 20 columns
  const drag = (a: [number, number], b: [number, number], now = 0) => {
    s.mouse({ x: a[0], y: a[1], release: false, motion: false }, now);
    const mid = s.mouse({ x: b[0], y: b[1], release: false, motion: true }, now);
    return { mid, end: s.mouse({ x: b[0], y: b[1], release: true, motion: false }, now) };
  };
  let r = drag([6, 0], [5, 1]);
  assert.strictEqual(r.end.copy, 'world\nsecond', 'drag across two rows');
  assert.deepStrictEqual(r.mid.repaint, [0, 1]);
  r = drag([5, 1], [6, 0], 1000);
  assert.strictEqual(r.end.copy, 'world\nsecond', 'dragging backwards selects the same');
  r = drag([18, 2], [3, 3], 2000);
  assert.strictEqual(r.end.copy, 'stuvwx', 'a wrapped line copies without a newline');
  assert.strictEqual(s.mouse({ x: 3, y: 0, release: false, motion: false }, 5000).copy, undefined);
  assert.strictEqual(s.mouse({ x: 3, y: 0, release: true, motion: false }, 5000).copy, undefined, 'a click copies nothing');
  assert.strictEqual(s.hasSelection(), false);
  s.mouse({ x: 8, y: 1, release: false, motion: false }, 9000);
  s.mouse({ x: 8, y: 1, release: true, motion: false }, 9000);
  assert.strictEqual(s.mouse({ x: 8, y: 1, release: false, motion: false }, 9200).copy, 'line', 'double-click: a word');
  s.mouse({ x: 8, y: 1, release: true, motion: false }, 9200);
  assert.strictEqual(s.mouse({ x: 8, y: 1, release: false, motion: false }, 9350).copy, 'second line here', 'triple-click: the line');
  console.log('✓ selection: drag (both ways, across a wrap), click, double-click word, triple-click line');

  // ---------- dragging past the edge scrolls (Herdr repaints the view one frame per scroll) ----------
  const tall = new Screen(20, 5);
  const view = (top: number) => `\x1b[2J\x1b[H${[0, 1, 2, 3, 4].map((i) => `L${top + i}`).join('\r\n')}`;
  await tall.write(view(10));
  tall.mouse({ x: 1, y: 3, release: false, motion: false }, 0);
  tall.mouse({ x: 1, y: 2, release: false, motion: true }, 0);
  assert.strictEqual(tall.edge(), undefined, 'not on an edge');
  tall.mouse({ x: 0, y: 0, release: false, motion: true }, 0);
  assert.strictEqual(tall.edge(), 'up', 'dragged onto the top row');
  tall.scrollSent('up', 1);
  assert.strictEqual(await tall.write(view(9)), 1, 'the view moved one line');
  assert.deepStrictEqual(tall.rowsOf(), [0, 1, 2, 3, 4], 'the selection follows the pointer into the new row');
  tall.scrollSent('up', 3);
  assert.strictEqual(await tall.write('\x1b[1;1Hnoise'), undefined, 'a frame that is not the scroll keeps it waiting');
  assert.strictEqual(await tall.write(view(6)), 3);
  assert.strictEqual(tall.mouse({ x: 0, y: 0, release: true, motion: false }, 0).copy, 'L6\nL7\nL8\nL9\nL10\nL11\nL12\nL1', 'rows that scrolled out of view are still copied');
  assert.ok(tall.paint([0]).includes('\x1b[0;7mL6'), 'the new top row is shown selected');
  tall.scrollSent('up', 3);
  assert.strictEqual(tall.scrollTimedOut(), 0, 'no frame: the top of the scrollback');
  tall.mouse({ x: 0, y: 0, release: false, motion: false }, 5000);
  tall.mouse({ x: 3, y: 0, release: false, motion: true }, 5000);
  assert.strictEqual(tall.edge(), undefined, 'selecting along the top row itself does not scroll');
  tall.mouse({ x: 3, y: 4, release: false, motion: true }, 5000);
  assert.strictEqual(tall.edge(), 'down', 'dragged onto the bottom row');
  tall.clearSelection();
  // A full-screen program (less, an agent's transcript) gets the scroll instead: its own step, a fixed footer.
  const pager = new Screen(20, 5);
  const page = (top: number) => `\x1b[2J\x1b[H${[0, 1, 2, 3].map((i) => `P${top + i}`).join('\r\n')}\r\n:`;
  await pager.write(page(50));
  pager.mouse({ x: 0, y: 2, release: false, motion: false }, 0);
  pager.mouse({ x: 0, y: 0, release: false, motion: true }, 0);
  for (let top = 49; top >= 46; top--) {
    pager.scrollSent('up', 3);
    assert.strictEqual(await pager.write(`\x1b[5;1H:${top}`), undefined, 'a spinner-like frame keeps it waiting');
    assert.strictEqual(await pager.write(page(top)), 1, 'the program moved one line, the footer stayed');
  }
  assert.strictEqual(pager.mouse({ x: 0, y: 0, release: true, motion: false }, 0).copy, 'P46\nP47\nP48\nP49\nP50\nP51\nP', 'the footer is not copied');
  console.log('✓ selection: dragging onto the top/bottom row scrolls, the selection keeps rows that scrolled away');

  // ---------- Backspace / Delete deletes a selection on the line being typed ----------
  const select = (sc: Screen, a: number, b: number, y = 0) => {
    sc.mouse({ x: a, y, release: false, motion: false }, 0);
    sc.mouse({ x: b, y, release: false, motion: true }, 0);
    sc.mouse({ x: b, y, release: true, motion: false }, 0);
  };
  const L = '\x1b[D';
  const R = '\x1b[C';
  const input = new Screen(30, 3);
  await input.write('$ echo hello world'); // cursor at column 18
  select(input, 7, 11); // "hello"
  assert.strictEqual(input.deleteKeys(), L.repeat(6) + '\x7f'.repeat(5), 'move to the end of "hello", then 5 backspaces');
  select(input, 13, 25); // "world" and the padding after it
  assert.strictEqual(input.deleteKeys(), '\x7f'.repeat(5), 'padding past the input is not deleted');
  await input.write('\x1b[1;3H'); // cursor on "echo"
  select(input, 13, 17);
  assert.strictEqual(input.deleteKeys(), R.repeat(16) + '\x7f'.repeat(5), 'a selection after the cursor: move right first');
  select(input, 0, 3, 1);
  assert.strictEqual(input.deleteKeys(), undefined, 'not the cursor row');
  input.wheel('up');
  select(input, 7, 11);
  assert.strictEqual(input.deleteKeys(), undefined, 'scrolled back: the cursor row is not on screen');
  input.inputSent();
  assert.ok(input.deleteKeys(), 'typing returns Herdr to the live screen');
  const wide = new Screen(30, 2);
  await wide.write('$ 日本語 ok'); // 日 2-3, 本 4-5, 語 6-7, cursor 11
  select(wide, 4, 5);
  assert.strictEqual(wide.deleteKeys(), L.repeat(4) + '\x7f', 'wide characters count once');
  select(wide, 3, 4);
  assert.strictEqual(wide.deleteKeys(), L.repeat(4) + '\x7f\x7f', 'half of a wide character selects all of it');
  console.log('✓ delete: arrows to the selection end + one backspace per character; only on the live cursor row');

  // ---------- painting ----------
  const colored = new Screen(10, 2);
  await colored.write('\x1b[1;31mred\x1b[0m plain');
  colored.mouse({ x: 1, y: 0, release: false, motion: false }, 0);
  colored.mouse({ x: 5, y: 0, release: false, motion: true }, 0);
  const p = colored.paint([0]);
  assert.ok(p.startsWith('\x1b[?2026h\x1b7') && p.endsWith('\x1b8\x1b[?2026l'), 'synchronized, cursor restored');
  assert.ok(p.includes('\x1b[0;1;31mr\x1b[0;1;7;31med'), `bold red kept, selection inverted: ${JSON.stringify(p)}`);
  assert.ok(p.includes('\x1b[0;7m pl\x1b[0main'), 'plain cells inverted only inside the selection');
  const toast = new Screen(30, 4).toast('✓ Copied to clipboard');
  assert.strictEqual(toast.row, 3);
  assert.ok(toast.paint.includes('\x1b[4;4H\x1b[0;1;30;42m ✓ Copied to clipboard \x1b[0m'), `toast centered on the bottom row: ${JSON.stringify(toast.paint)}`);
  assert.ok(toast.paint.endsWith('\x1b8\x1b[?2026l'), 'cursor restored');
  console.log('✓ painting: colors and attributes kept, selection inverted, cursor restored; copied toast');

  // ---------- the stream client, against a fake herdr ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-stream-'));
  const log = path.join(dir, 'stdin.log');
  const fake = path.join(dir, 'herdr');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'argv'))}, process.argv.slice(2).join(' '));
const frame = (s, full) => console.log(JSON.stringify({ type: 'terminal.frame', encoding: 'ansi', full, seq: 1, width: 80, height: 24, bytes: Buffer.from(s).toString('base64') }));
frame('\\x1b[2J\\x1b[1;1Hhello', true);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
    const c = JSON.parse(line);
    if (c.type === 'terminal.input') frame(Buffer.from(c.bytes, 'base64').toString(), false);
    if (c.type === 'terminal.release') { console.log(JSON.stringify({ type: 'terminal.closed', reason: 'detached' })); process.exit(0); }
  }
});
`,
    { mode: 0o755 },
  );
  const frames: string[] = [];
  let closed: { reason?: string; error?: string } | undefined;
  const st = new HerdrStream(fake, 'w1:p2', { cols: 80, rows: 24 }, process.env, {
    onFrame: (b, full) => frames.push(`${full ? 'F' : 'd'}:${b.toString()}`),
    onClose: (i) => (closed = i),
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  await until(() => frames.length === 1);
  st.input('é\r');
  st.resize(100, 30);
  st.scroll('up', 3);
  st.mouse('down', 'left', 4, 2, 1);
  await until(() => frames.length === 2);
  st.release();
  await until(() => !!closed);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'argv'), 'utf8'), 'terminal session control w1:p2 --takeover --cols 80 --rows 24');
  assert.deepStrictEqual(frames, ['F:\x1b[2J\x1b[1;1Hhello', 'd:é\r']);
  assert.deepStrictEqual(
    fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    [
      { type: 'terminal.input', bytes: Buffer.from('é\r').toString('base64') },
      { type: 'terminal.resize', cols: 100, rows: 30 },
      { type: 'terminal.scroll', direction: 'up', lines: 3 },
      { type: 'terminal.mouse', action: 'down', button: 'left', column: 4, row: 2, modifiers: 1 },
      { type: 'terminal.release' },
    ],
  );
  assert.deepStrictEqual(closed, { reason: 'detached' });
  let failed: { error?: string } | undefined;
  new HerdrStream(path.join(dir, 'missing'), 'w1:p1', { cols: 80, rows: 24 }, process.env, { onFrame: () => {}, onClose: (i) => (failed = i) });
  await until(() => !!failed);
  assert.ok(failed?.error, 'a missing herdr reports an error');
  console.log('✓ stream client: argv, frames, input (UTF-8), resize, scroll, release, missing binary');

  // Read-only: `observe`, no --takeover, and nothing is sent to it.
  fs.rmSync(log, { force: true });
  const oframes: string[] = [];
  let oclosed: object | undefined;
  const ob = new HerdrStream(fake, 'w1:p2', { cols: 100, rows: 30 }, process.env, { onFrame: (b) => oframes.push(b.toString()), onClose: (i) => (oclosed = i) }, 'observe');
  await until(() => oframes.length === 1);
  ob.input('x');
  ob.resize(90, 20);
  ob.scroll('up', 1);
  ob.mouse('down', 'left', 1, 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'argv'), 'utf8'), 'terminal session observe w1:p2 --cols 100 --rows 30');
  assert.ok(!fs.existsSync(log), 'an observer sends nothing');
  ob.release();
  await until(() => !!oclosed);
  assert.ok(oclosed, 'release stops an observer');
  assert.ok(isTakenOver('terminal attach taken over') && !isTakenOver('detached') && !isTakenOver(undefined));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ observer: read-only argv, sends nothing, stops on release; taken-over reason recognized');
  console.log('\nstream tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
