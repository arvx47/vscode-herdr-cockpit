// Finding a Claude Code session's last message from you (agents/sessionText.ts), on transcripts written to a
// temporary folder in the shape Claude Code writes them.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeProjectDir, humanMessage, SessionRequests } from '../agents/sessionText';

const line = (o: object) => JSON.stringify(o) + '\n';
const human = (text: string) => line({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const reply = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
const title = (t: string) => line({ type: 'ai-title', aiTitle: t });

// ---- what counts as your message
assert.strictEqual(humanMessage(JSON.parse(human('  fix the\n login   bug '))), 'fix the login bug');
assert.strictEqual(humanMessage(JSON.parse(toolResult)), undefined, 'tool results are not yours');
assert.strictEqual(humanMessage({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } }), undefined);
assert.strictEqual(humanMessage({ type: 'user', isMeta: true, message: { content: 'x' } }), undefined, 'injected text');
assert.strictEqual(humanMessage(JSON.parse(human('<command-name>/clear</command-name>'))), undefined, 'slash commands');
assert.strictEqual(humanMessage({ type: 'user', message: { content: [{ type: 'text', text: 'older Claude Code' }] } }), 'older Claude Code', 'no origin: text blocks');
assert.strictEqual(humanMessage(JSON.parse(human('x'.repeat(400))))!.length, 300, 'cut to 300 characters');
console.log('✓ your messages: typed text only, whitespace folded, cut');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-session-'));
  try {
    const work = path.join(tmp, '.claude-work');
    const cwd = '/Users/dev/code/my.app';
    const project = claudeProjectDir(work, cwd);
    assert.strictEqual(path.basename(project), '-Users-dev-code-my-app', "Claude Code's folder name: everything but letters and digits is -");
    fs.mkdirSync(project, { recursive: true });
    const write = (name: string, body: string, age: number) => {
      const f = path.join(project, name);
      fs.writeFileSync(f, body);
      const t = new Date(Date.now() - age * 1000);
      fs.utimesSync(f, t, t);
      return f;
    };
    write('a.jsonl', title('Fix login') + human('fix the login bug') + reply + human('now add a test') + toolResult + title('Fix login'), 10);
    write('b.jsonl', title('Docs') + human('update the README') + reply, 5);
    write('r.jsonl', title('Auto title') + line({ type: 'custom-title', customTitle: 'OUT-1' }) + human('check the ticket') + title('Auto title'), 7);
    const r = new SessionRequests(0);
    const dirs = [path.join(tmp, '.claude'), work];
    assert.strictEqual(await r.find(dirs, cwd, 'Fix login'), 'now add a test', 'the session with that title, your last message');
    assert.strictEqual(await r.find(dirs, cwd, 'Docs'), 'update the README');
    assert.strictEqual(await r.find(dirs, cwd, 'OUT-1'), 'check the ticket', 'a renamed session: its name wins over later titles');
    assert.strictEqual(await r.find(dirs, cwd, 'Something else'), undefined, 'no session with that title');
    assert.strictEqual(await r.find(dirs, cwd, undefined), undefined, 'no title, no guess');
    assert.strictEqual(await r.find(dirs, '/elsewhere', 'Docs'), undefined, 'another folder');

    // A newer session with the same title wins; a file that grows is read again.
    const c = write('c.jsonl', title('Docs') + human('fix a typo in the docs') + reply, 1);
    assert.strictEqual(await r.find(dirs, cwd, 'Docs'), 'fix a typo in the docs');
    fs.appendFileSync(c, human('and the changelog'));
    assert.strictEqual(await r.find(dirs, cwd, 'Docs'), 'and the changelog', 'read again after it changed');

    // A long turn: your message is more than the first tail read from the end.
    const big = 'x'.repeat(2000);
    const filler = Array.from({ length: 300 }, () => line({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } })).join('');
    write('d.jsonl', title('Long') + human('refactor everything') + filler + title('Long'), 0);
    assert.strictEqual(await r.find(dirs, cwd, 'Long'), 'refactor everything', 'found further back in a big transcript');
    // A session renamed long ago: its /rename name is far before the end, behind later titles and a message of yours.
    const renamed = write('e.jsonl', line({ type: 'custom-title', customTitle: 'OUT-2' }) + title('Auto') + filler + human('ship it') + title('Auto'), 0);
    assert.strictEqual(await r.find(dirs, cwd, 'OUT-2'), 'ship it', 'a /rename name more than the tail back still counts');
    assert.strictEqual(await r.find(dirs, cwd, 'Auto'), undefined, "its later automatic title isn't its name");
    fs.appendFileSync(renamed, line({ type: 'custom-title', customTitle: 'OUT-3' }) + human('and merge it'));
    assert.strictEqual(await r.find(dirs, cwd, 'OUT-3'), 'and merge it', 'a rename added later, read from where it stopped');
    // Panes in one folder share its listing within a poll: a file added meanwhile shows up on the next one.
    const shared = new SessionRequests(60_000);
    assert.strictEqual(await shared.find(dirs, cwd, 'Docs'), 'and the changelog');
    write('f.jsonl', title('Fresh') + human('new session') + reply, 0);
    assert.strictEqual(await shared.find(dirs, cwd, 'Fresh'), undefined, 'the same listing within the poll');
    assert.strictEqual(await new SessionRequests(0).find(dirs, cwd, 'Fresh'), 'new session');
    // An account whose projects folder links to another's: its files are counted once, so 20 distinct sessions fit.
    const linked = path.join(tmp, '.claude-linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(work, 'projects'), path.join(linked, 'projects'));
    for (let i = 0; i < 15; i++) {
      write(`n${i}.jsonl`, title(`New ${i}`) + human(`task ${i}`) + reply, -10 - i); // newer than the rest
    }
    assert.strictEqual(await new SessionRequests(0).find([...dirs, linked], cwd, 'Docs'), 'and the changelog', 'still among the 20 newest');
    console.log('✓ the session matched by folder and title, newest first, re-read when it grows, big transcripts');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\nsession text tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
