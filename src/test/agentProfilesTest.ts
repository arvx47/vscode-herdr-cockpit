// The agent list (src/agentProfiles.ts): herdr.agents' rows (plain, renamed, with their own variables), what older
// versions saved, and an agent recognized by the row it was started from.
import * as assert from 'assert';
import * as path from 'path';
import { DEFAULT_AGENTS, parseProfileSpec, profileOfAgent, readAgentList, readAgentProfiles, startingTable } from '../agentProfiles';

const home = path.join(path.sep, 'home', 'someone');
const names = (r: { profiles: { name: string }[] }) => r.profiles.map((p) => p.name);

// Not set: the defaults, as they come
{
  const list = readAgentList(undefined, home);
  assert.deepStrictEqual(names(list), ['Claude', 'Codex', 'Kiro', 'Cursor']);
  assert.ok(list.profiles.every((p) => p.plain && !Object.keys(p.env).length), 'plain agents: their usual names, no variables');
  assert.deepStrictEqual(list.problems, []);
  console.log('✓ the default list');
}

// The table, as written, is the whole list: accounts, renames, mistakes skipped with a reason
{
  const list = readAgentList(
    {
      'Claude (personal)': 'claude',
      'Claude (second)': 'claude CLAUDE_CONFIG_DIR=~/.claude-second',
      'Codex (work)': '  codex   CODEX_HOME=~/.codex-work  ',
      Hidden: '',
      Gemini: 'gemini',
      'No agent': 'CLAUDE_CONFIG_DIR=~/x',
      'Bad var': 'claude NOT-A-NAME=1',
      'Not text': 3,
    },
    home,
  );
  assert.deepStrictEqual(names(list), ['Claude (personal)', 'Claude (second)', 'Codex (work)', 'Gemini'], 'no defaults added back; an empty row skipped');
  const by = (n: string) => list.profiles.find((p) => p.name === n)!;
  assert.deepStrictEqual(by('Claude (second)').env, { CLAUDE_CONFIG_DIR: path.join(home, '.claude-second') });
  assert.strictEqual(by('Claude (personal)').plain, false, 'renamed: its agents are named after the row');
  assert.strictEqual(by('Claude (personal)').slug, 'claude-personal');
  assert.deepStrictEqual(by('Codex (work)').env, { CODEX_HOME: path.join(home, '.codex-work') });
  assert.strictEqual(by('Gemini').plain, true);
  assert.strictEqual(list.problems.length, 3, list.problems.join('\n'));
  assert.deepStrictEqual(parseProfileSpec(''), { problem: 'starts with the agent (claude, codex, kiro, …), then NAME=value variables' });
  console.log('✓ the table is the list: accounts, renames, mistakes skipped');
}

// The starting list, written into the user settings once (the Settings page can't rename or delete default rows)
{
  assert.deepStrictEqual(startingTable(undefined, undefined), DEFAULT_AGENTS, 'nothing yet: the defaults');
  // What the Settings page saved when Claude was renamed: only the new row; it takes Claude's place
  const renamed = startingTable({ 'Claude (second)': 'claude CLAUDE_CONFIG_DIR=~/.claude-second', 'Claude (renamed)': 'claude' }, undefined);
  assert.deepStrictEqual(Object.keys(renamed), ['Claude (renamed)', 'Codex', 'Kiro', 'Cursor', 'Claude (second)']);
  // A default set to empty is taken off; a row with variables alone doesn't replace the default
  assert.deepStrictEqual(Object.keys(startingTable({ Cursor: '', 'Claude (w)': 'claude X=1' }, undefined)), ['Claude', 'Codex', 'Kiro', 'Claude (w)']);
  // The old herdr.agents list of agent kinds: those, in that order
  assert.deepStrictEqual(startingTable(['claude', 'gemini'], undefined), { Claude: 'claude', Gemini: 'gemini' });
  assert.deepStrictEqual(names(readAgentList(['claude', 'gemini'], home)), ['Claude', 'Gemini'], 'still read before it is moved');
  // The old herdr.agentProfiles: its table (0.3.26–0.3.28) or its list of objects (0.3.22–0.3.23)
  const fromTable = startingTable(undefined, { 'Claude (second)': 'claude CLAUDE_CONFIG_DIR=~/.claude-second' });
  const fromObjects = startingTable(undefined, [{ name: 'Claude (second)', kind: 'claude', env: { CLAUDE_CONFIG_DIR: '~/.claude-second' } }, { nope: 1 }]);
  assert.deepStrictEqual(fromTable, { ...DEFAULT_AGENTS, 'Claude (second)': 'claude CLAUDE_CONFIG_DIR=~/.claude-second' });
  assert.deepStrictEqual(fromObjects, fromTable);
  console.log('✓ the starting list: renames in place, older settings moved in');
}

// An agent is recognized by the row it was started from (its name), but not a plain one
{
  const list = readAgentList({ 'Claude (work)': 'claude CLAUDE_CONFIG_DIR=~/.claude-work' }, home).profiles;
  assert.strictEqual(profileOfAgent(list, 'claude-work')?.name, 'Claude (work)');
  assert.strictEqual(profileOfAgent(list, 'claude-work-2')?.name, 'Claude (work)');
  assert.strictEqual(profileOfAgent(list, 'claude'), undefined, 'a plain Claude is not the row');
  assert.strictEqual(profileOfAgent(list, 'claude-work-x'), undefined);
  assert.strictEqual(profileOfAgent(list, undefined), undefined);
  console.log("✓ a row's agents recognized by name");
}

// Entries are read safely: names, variables, duplicates
{
  const { profiles, problems } = readAgentProfiles(
    [{ name: 'Claude (work)', env: { OK: '~', 'NOT VALID': 'x', NUM: 1 } }, { name: 'claude work' }, { kind: 'claude' }, 'x'],
    home,
  );
  assert.deepStrictEqual(profiles.map((p) => [p.name, p.env]), [['Claude (work)', { OK: home }]]);
  assert.strictEqual(problems.length, 5, problems.join('\n'));
  console.log('✓ entries read safely');
}

console.log('\nagent list tests passed');
