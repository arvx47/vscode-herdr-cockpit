// Runs inside the test editor started by run.ts: the Cockpit window, against the throwaway hb-vsc Herdr session.
import * as assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { writeClaim } from '../../hubFiles';

const SESSION = process.env.HERDR_HUB_TEST_SESSION ?? '';
const [S1, S2] = (process.env.HERDR_HUB_TEST_SPACES ?? '').split(',');
const BIN = process.env.HERDR_BIN ?? 'herdr';

// The editor runs with a temporary HOME (its Cockpit window); the herdr CLI needs the real one to find the session.
const herdr = (...args: string[]) =>
  JSON.parse(execFileSync(BIN, args, { env: { ...process.env, HOME: process.env.HERDR_HUB_TEST_REAL_HOME, HERDR_SESSION: SESSION }, encoding: 'utf8' }));
const panesOf = (ws: string): string[] =>
  herdr('api', 'snapshot')
    .result.snapshot.panes.filter((p: any) => p.workspace_id === ws)
    .map((p: any) => p.pane_id);
const pane = (id: string): any => herdr('api', 'snapshot').result.snapshot.panes.find((p: any) => p.pane_id === id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await ok()) return;
    } catch {
      // not yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const hubStatus = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.herdr-cockpit', 'status', `${vscode.env.uriScheme}.json`), 'utf8'));
/** Herdr Cockpit's tabs: drawn by the extension (a pty), never a shell process. */
const ours = () => vscode.window.terminals.filter((t) => 'pty' in (t.creationOptions as object));
const step = (s: string) => console.log(`[herdr-cockpit test] ${s}`);

export async function run(): Promise<void> {
  try {
    await steps();
  } catch (e) {
    console.log('folders:', JSON.stringify(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)));
    console.log('terminals:', JSON.stringify(vscode.window.terminals.map((t) => ({ name: t.name, pty: 'pty' in (t.creationOptions as object), opts: Object.keys(t.creationOptions), exit: t.exitStatus }))));
    console.log('active terminal:', vscode.window.activeTerminal?.name);
    for (const t of vscode.window.terminals) console.log(`exit ${t.name}:`, JSON.stringify(t.exitStatus));
    for (const t of ours()) {
      const pty: any = (t.creationOptions as vscode.ExtensionTerminalOptions).pty;
      const b = pty.screen?.term.buffer.active;
      const lines = b ? Array.from({ length: pty.screen.rows }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true)).filter((l: string) => l?.trim()) : 'no screen';
      console.log(`tab ${t.name}: ended=${pty.ended} stream=${!!pty.stream} size=${pty.screen?.cols}x${pty.screen?.rows} screen=`, JSON.stringify(lines));
    }
    console.log('default profile:', JSON.stringify(vscode.workspace.getConfiguration('terminal.integrated').inspect(`defaultProfile.${process.platform === 'darwin' ? 'osx' : 'linux'}`)));
    try {
      console.log('herdr panes S1:', JSON.stringify(panesOf(S1)), 'status:', JSON.stringify(hubStatus()));
    } catch (x) {
      console.log('status unavailable', x);
    }
    throw e;
  }
}

async function steps(): Promise<void> {
  await vscode.extensions.getExtension('sriharirao.herdr-cockpit')!.activate();
  assert.strictEqual(vscode.workspace.workspaceFile?.fsPath, path.join(os.homedir(), '.herdr-cockpit', 'herdr-cockpit.code-workspace'), 'runs in the Cockpit window');
  await until('connected to Herdr', () => hubStatus().connected === true);
  step('connected');

  // 0. The Welcome page (open in a new window) is closed when a space opens.
  await vscode.commands.executeCommand('workbench.action.openWalkthrough');
  await until('the Welcome page', () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Welcome')));

  // 1. Switching to a space opens its pane as a built-in tab.
  await vscode.commands.executeCommand('herdr.switchSpace', { spaceId: S1 });
  try {
    await until('the space tab (a fresh editor can be slow to mount the first space)', () => ours().length === 1, 30_000);
  } catch (e) {
    console.log('folders:', JSON.stringify(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)));
    console.log('terminals:', JSON.stringify(vscode.window.terminals.map((t) => ({ name: t.name, pty: 'pty' in (t.creationOptions as object), exit: t.exitStatus }))));
    console.log('status:', JSON.stringify(hubStatus()));
    throw e;
  }
  const first = ours()[0];
  assert.strictEqual(vscode.window.terminals.length, 1, 'no other terminals');
  await until('the Welcome page closed', () => !vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Welcome')), 5000);
  step('switch space: built-in tab opened, Welcome page closed');

  // 2. The editor group's "+" (default profile "Herdr Shell") creates a Herdr tab and a built-in tab, tracked.
  first.show();
  await sleep(300);
  await vscode.commands.executeCommand('workbench.action.createTerminalEditorSameGroup');
  await until('"+" created a Herdr tab and a built-in tab', () => ours().length === 2 && panesOf(S1).length === 2);
  const plus = ours().find((t) => t !== first)!;
  await until('the "+" tab is tracked', () => hubStatus().tabs === 2);
  step('"+": Herdr tab created, built-in tab, tracked');

  // 2b. Showing a Herdr tab and moving the active editor moves that tab: how reopened tabs are put back in order.
  const tabLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTerminal).map((t) => t.label);
  assert.notStrictEqual(first.name, plus.name, 'the two tabs have different names');
  for (const term of [plus, first]) {
    term.show(false);
    await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: 1 });
    await until(`"${term.name}" moved first`, () => tabLabels()[0] === term.name, 5000);
  }
  step('a Herdr tab moves to a given position');

  // 3. Selecting in it copies (double-click a word).
  const pty: any = (plus.creationOptions as vscode.ExtensionTerminalOptions).pty;
  pty.handleInput('echo SELECT-ME-42\r');
  const rowOf = () => {
    const b = pty.screen.term.buffer.active;
    for (let y = 0; y < pty.screen.rows; y++) if (b.getLine(b.viewportY + y)?.translateToString(true).trimEnd() === 'SELECT-ME-42') return y; // Herdr paints rows with real spaces
    return -1;
  };
  await until('the output row', () => rowOf() >= 0);
  const y = rowOf() + 1;
  const saved = await vscode.env.clipboard.readText();
  try {
    pty.handleInput(`\x1b[<0;3;${y}M\x1b[<0;3;${y}m`);
    pty.handleInput(`\x1b[<0;3;${y}M\x1b[<0;3;${y}m`);
    await until('the word on the clipboard', async () => (await vscode.env.clipboard.readText()) === 'SELECT-ME-42', 5000);
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
  step('double-click copied the word');

  // 3a. A drag held on the top row scrolls Herdr's scrollback and keeps selecting; Backspace deletes a selection
  //     on the line being typed.
  const rows = (): string[] => {
    const b = pty.screen.term.buffer.active;
    return Array.from({ length: pty.screen.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true).trimEnd() ?? '');
  };
  pty.handleInput('clear; seq 1 200\r');
  await until('the seq output', () => rows().includes('195'));
  const from = rows().indexOf('195') + 1;
  const top = Number(rows()[0]) || 200; // the first number on screen (the tab may be taller than the output)
  const saved2 = await vscode.env.clipboard.readText();
  try {
    pty.handleInput(`\x1b[<0;3;${from}M\x1b[<32;3;${from - 1}M\x1b[<32;1;1M`);
    await until('scrolled back while the drag is held on the top row', () => Number(rows()[0]) < Math.max(2, top - 10), 8000);
    pty.handleInput('\x1b[<0;1;1m');
    let lines: string[] = [];
    await until('the selection on the clipboard', async () => (lines = (await vscode.env.clipboard.readText()).split('\n')).at(-1) === '195', 5000);
    assert.ok(Number(lines[0]) < top && lines.every((l, i) => Number(l) === Number(lines[0]) + i), `contiguous rows from the scrollback (top was ${top}): ${lines.join(',')}`);
    step(`a drag held on the top row scrolled and selected ${lines.length} rows`);

    pty.handleInput('\x03echo hello world');
    const at = () => rows().findIndex((l) => l.endsWith('echo hello world'));
    await until('the typed line', () => at() >= 0);
    const yy = at() + 1;
    const xx = rows()[at()].lastIndexOf('hello') + 2;
    pty.handleInput(`\x1b[<0;${xx};${yy}M\x1b[<0;${xx};${yy}m\x1b[<0;${xx};${yy}M\x1b[<0;${xx};${yy}m`);
    await until('"hello" selected', async () => (await vscode.env.clipboard.readText()) === 'hello', 5000);
    pty.handleInput('\x7f');
    await until('Backspace deleted the selection', () => rows()[yy - 1].endsWith('echo  world'), 5000);
    pty.handleInput('\x03');
  } finally {
    await vscode.env.clipboard.writeText(saved2);
  }
  step('Backspace deleted the selected word from the line being typed');

  // 3a'. Find: ⌘F's keybinding runs sendSequence with the tab's private sequence. It searches the whole history in
  //      Herdr and scrolls Herdr's view to each match.
  const seq = (a: string) => `\x1b]777;herdr-cockpit;${a}\x07`;
  const pid: string = pty.paneId;
  const scrollOf = () => pane(pid)?.scroll ?? {};
  plus.show();
  await sleep(300);
  pty.handleInput('clear; for i in $(seq 1 300); do echo "item $i"; done; echo FINDME-77\r');
  await until('the output', () => rows().includes('FINDME-77'));
  await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: seq('find') });
  await until('the find bar is open', () => !!pty.find);
  pty.handleInput('item 42');
  await until('"item 42" found and scrolled to', () => pty.find?.cur === 0 && rows().includes('item 42'), 8000);
  assert.strictEqual(pty.find.matches.length, 1);
  assert.ok(scrollOf().offset_from_bottom > 0, 'Herdr scrolled back to it');
  pty.handleInput('\x15/item 1\\d$/');
  await until('a regex: 10 matches, starting at the one above the last', () => pty.find?.matches.length === 10 && pty.find.cur === 9 && rows().includes('item 19'), 8000);
  pty.handleInput('\r');
  await until('Enter: the older one', () => pty.find.cur === 8 && rows().includes('item 18'), 5000);
  pty.handleInput('\x1b[B');
  await until('↓: the newer one', () => pty.find.cur === 9, 5000);
  pty.handleInput('\x1b');
  await until('Esc closes the bar', () => !pty.find);
  step('find: whole history, regex, Enter / ↓ between matches, Esc closes');

  pty.handleInput(seq('top'));
  await until('scrolled to the top of the history', () => scrollOf().offset_from_bottom > 0 && scrollOf().offset_from_bottom === scrollOf().max_offset_from_bottom);
  pty.handleInput(seq('bottom'));
  await until('back at the bottom', () => scrollOf().offset_from_bottom === 0);
  step('scroll to top / bottom of the history');

  await vscode.commands.executeCommand('herdr.terminal.openOutput');
  await until('the output in an editor', () => !!vscode.window.activeTextEditor?.document.getText().includes('FINDME-77'));
  assert.ok(vscode.window.activeTextEditor!.document.getText().includes('item 1\n'), 'the whole history, not just the screen');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  step('Open Output in Editor: the whole history in a document');

  plus.show();
  await sleep(300);
  const saved3 = await vscode.env.clipboard.readText();
  try {
    pty.handleInput('\x03echo hello world');
    const at2 = () => rows().findIndex((l) => l.endsWith('echo hello world'));
    await until('the typed line', () => at2() >= 0);
    const y2 = at2() + 1;
    const x2 = rows()[at2()].lastIndexOf('hello') + 2;
    pty.handleInput(`\x1b[<0;${x2};${y2}M\x1b[<0;${x2};${y2}m\x1b[<0;${x2};${y2}M\x1b[<0;${x2};${y2}m`);
    await until('"hello" selected', async () => (await vscode.env.clipboard.readText()) === 'hello', 5000);
    pty.handleInput('X');
    await until('typing replaced the selection', () => rows()[y2 - 1].endsWith('echo X world'), 5000);
    const xe = rows()[y2 - 1].lastIndexOf('echo') + 1;
    pty.handleInput(`\x1b[<8;${xe};${y2}M\x1b[<8;${xe};${y2}m`); // Option+click on "echo"
    await sleep(300);
    pty.handleInput('Y');
    await until('Option+click moved the cursor', () => rows()[y2 - 1].endsWith('Yecho X world'), 5000);
    pty.handleInput('\x03');
  } finally {
    await vscode.env.clipboard.writeText(saved3);
  }
  step('typing replaced a selection; Option+click moved the cursor');

  // 3b. Renaming the tab (its Rename... = renameWithArg on the active terminal) renames the pane in Herdr.
  const plusPane = panesOf(S1).find((id) => id !== panesOf(S1)[0])!;
  plus.show();
  await sleep(300);
  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'logs here' });
  await until('the pane renamed in Herdr', () => pane(plusPane)?.label === 'logs here');
  step('renaming a tab renamed the pane in Herdr');

  // 3c. A pane renamed in Herdr renames its tab, without taking focus.
  const firstPane = panesOf(S1).find((id) => id !== plusPane)!;
  herdr('pane', 'rename', firstPane, 'from herdr');
  await until('the tab renamed (Herdr sends no rename event: the 5s poll picks it up)', () => first.name === 'Herdr: from herdr', 12_000);
  assert.strictEqual(vscode.window.activeTerminal, plus, 'focus stayed on the active tab');
  step('a pane renamed in Herdr renamed its tab, focus unchanged');

  // 3d. Split Terminal on a Herdr tab splits that pane in Herdr (same Herdr tab), in a new editor group.
  first.show();
  await sleep(300);
  const groups = vscode.window.tabGroups.all.length;
  await vscode.commands.executeCommand('workbench.action.terminal.split');
  await until('the split pane in Herdr', () => panesOf(S1).length === 3);
  const splitPane = panesOf(S1).find((id) => id !== firstPane && id !== plusPane)!;
  assert.strictEqual(pane(splitPane).tab_id, pane(firstPane).tab_id, 'split into the same Herdr tab');
  await until('a third built-in tab, tracked', () => ours().length === 3 && hubStatus().tabs === 3);
  assert.ok(vscode.window.tabGroups.all.length > groups, 'beside it, in a new editor group');
  step('Split Terminal split the pane in Herdr');

  // 4. Closing the tab yourself (its X: close that exact tab) closes the idle shell in Herdr.
  const plusTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTerminal && t.label === 'Herdr: logs here');
  assert.ok(plusTab, 'the tab is in the editor area');
  await vscode.window.tabGroups.close(plusTab);
  await until('the tab closed', () => !ours().includes(plus));
  assert.strictEqual(plus.exitStatus?.reason, vscode.TerminalExitReason.User, 'closed by the user');
  await until('the pane closed in Herdr', () => panesOf(S1).length === 2 && !panesOf(S1).includes(plusPane));
  step('closing the tab closed the shell in Herdr');

  // 5. Switching spaces only detaches: the first space's pane keeps running.
  await vscode.commands.executeCommand('herdr.switchSpace', { spaceId: S2 });
  await until('the other space tab', () => ours().length === 1 && ours()[0] !== first);
  assert.strictEqual(first.exitStatus?.reason, vscode.TerminalExitReason.Extension);
  await sleep(500);
  assert.strictEqual(panesOf(S1).length, 2, 'still running in Herdr');
  step('switching spaces only detached');

  // 5b. Another client takes the pane over: the tab keeps showing it read-only and says who has it (from the
  // claim that client's Cockpit window wrote), and typing in it takes control back.
  const s2tab = ours()[0];
  const s2pane = panesOf(S2)[0];
  const s2pty: any = (s2tab.creationOptions as vscode.ExtensionTerminalOptions).pty;
  const realEnv = { ...process.env, HOME: process.env.HERDR_HUB_TEST_REAL_HOME, HERDR_SESSION: SESSION };
  const kiro = spawn('sleep', ['120']); // stands in for Kiro's extension host
  // Like a Cockpit window: the claim first, then take the pane.
  writeClaim(vscode.workspace.getConfiguration('herdr').get<string>('socketPath')!, s2pane, { editor: 'Kiro', scheme: 'kiro', pid: kiro.pid!, at: Date.now() });
  const other = spawn(BIN, ['terminal', 'session', 'control', s2pane, '--takeover', '--cols', '80', '--rows', '24'], { env: realEnv });
  let otherOut = '';
  other.stdout.on('data', (d) => (otherOut += d));
  try {
    await until('the tab shows the pane read-only', () => s2pty.observing === true);
    assert.ok(ours().includes(s2tab) && !s2pty.ended, 'the tab stays open');
    assert.match(s2pty.note(), /Kiro is using this pane · type here to take it back/);
    execFileSync(BIN, ['pane', 'send-text', s2pane, 'echo SEEN-READ-ONLY\n'], { env: realEnv });
    const screenHas = (text: string) => {
      const b = s2pty.screen.term.buffer.active;
      for (let y = 0; y < s2pty.screen.rows; y++) if (b.getLine(b.viewportY + y)?.translateToString(true).includes(text)) return true;
      return false;
    };
    await until('read-only output keeps coming', () => screenHas('SEEN-READ-ONLY'));
    step('taken over: the tab shows the pane read-only and names who has it');

    s2pty.handleInput('x'); // takes control back; the keystroke itself isn't sent
    await until('control taken back', () => s2pty.observing === false && /taken over/.test(otherOut));
    s2pty.handleInput('echo BACK-IN-CONTROL\r');
    await until('typing works again', () => screenHas('BACK-IN-CONTROL'));
    assert.ok(!screenHas('xecho BACK'), 'the keystroke that took control back was not sent');
    step('typing took control back');
  } finally {
    other.kill();
    kiro.kill();
  }

  // (For 7: another editor's Cockpit window has S1's first pane. Closing S2's last pane below makes Herdr focus S1,
  // which this window follows, so the claim must exist first.)
  const [p1, p2] = panesOf(S1);
  const kiro2 = spawn('sleep', ['120']);
  writeClaim(vscode.workspace.getConfiguration('herdr').get<string>('socketPath')!, p1, { editor: 'Kiro', scheme: 'kiro', pid: kiro2.pid!, at: Date.now() });

  // 6. A pane closed in Herdr closes its tab here (reason Extension: nothing is closed back in Herdr).
  herdr('pane', 'close', panesOf(S2)[0]);
  await until('the tab of the closed pane closed', () => !ours().includes(s2tab));
  assert.strictEqual(s2tab.exitStatus?.reason, vscode.TerminalExitReason.Extension);
  assert.strictEqual(panesOf(S1).length, 2, 'other spaces untouched');
  step('a pane closed in Herdr closed its tab');

  // 7. Following a space switch made in Herdr, a pane another editor's Cockpit window has stays with it: shown
  // read-only here. The space's other panes are taken as usual.
  try {
    execFileSync(BIN, ['workspace', 'focus', S1], { env: realEnv });
    const ptyOf = (id: string): any => ours().map((t) => (t.creationOptions as vscode.ExtensionTerminalOptions).pty as any).find((x) => x.paneId === id);
    await until('followed to the space, both panes as tabs', () => !!ptyOf(p1)?.screen && !!ptyOf(p2)?.screen);
    await until("Kiro's pane read-only, the other one controlled", () => ptyOf(p1).observing === true && ptyOf(p2).observing === false);
    assert.match(ptyOf(p1).note(), /^.*Kiro is using this pane/);
    step('following Herdr: a pane another window has is shown read-only, the others are taken');
  } finally {
    kiro2.kill();
  }
}
