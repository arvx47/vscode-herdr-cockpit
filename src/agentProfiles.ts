// The agent list (herdr.agents, a table in the Settings page: name as listed → "agent NAME=value …"). Each row is
// one entry in the pickers: a plain agent ("Claude" → "claude"), the same one renamed ("Claude (personal)" →
// "claude"), or one started with its own environment, like a second Claude Code account (`claude
// CLAUDE_CONFIG_DIR=~/.claude-work`, what an alias such as `claude-work="CLAUDE_CONFIG_DIR=~/.claude-work claude"`
// does). Herdr gives a new pane the row's variables (tab.create / pane.split / workspace.create take `env`), then
// starts the agent in it. No vscode imports (test/agentProfilesTest.ts).
import { agentSlug, agentTitle } from './herdrActions';
import { expandHome } from './herdrClient';

export interface AgentProfile {
  /** As the pickers show it, e.g. "Claude (work)". */
  name: string;
  /** The Herdr agent kind it starts ("claude"). */
  kind: string;
  /** Variables the new pane gets, `~` expanded. */
  env: Record<string, string>;
  /** Extra arguments for the agent. */
  args: string[];
  /** Its agents' name in Herdr ("claude-work", then "claude-work-2"): how a closed one is recognized again. */
  slug: string;
  /**
   * The agent as it comes, under its usual name and without variables ("Claude" → "claude"): its agents keep
   * Herdr's usual names ("claude", "claude-2"). Any other row names its agents after itself.
   */
  plain: boolean;
}

/** The list until you change it: the agents most people use, as they come. */
export const DEFAULT_AGENTS: Record<string, string> = { Claude: 'claude', Codex: 'codex', Kiro: 'kiro', Cursor: 'cursor' };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An entry's agent kind, Claude when it doesn't say. */
function kindOf(kind: unknown): string {
  if (typeof kind === 'string' && kind.trim()) {
    return kind.trim();
  }
  return 'claude';
}

/** Profile entries ({name, kind, env, args}) as profiles, and what's wrong with entries left out (to log). */
export function readAgentProfiles(raw: unknown, home: string): { profiles: AgentProfile[]; problems: string[] } {
  const profiles: AgentProfile[] = [];
  const problems: string[] = [];
  if (!Array.isArray(raw)) {
    return { profiles, problems };
  }
  raw.forEach((entry, i) => {
    const where = `profile ${i + 1}`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where}: not an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const slug = agentSlug(name);
    if (!name || !slug) {
      problems.push(`${where}: needs a "name" with a letter in it`);
      return;
    }
    if (profiles.some((p) => p.slug === slug)) {
      problems.push(`${where}: "${name}" is the same as an earlier profile`);
      return;
    }
    const kind = kindOf(e.kind);
    const env: Record<string, string> = {};
    if (e.env && typeof e.env === 'object' && !Array.isArray(e.env)) {
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        if (!ENV_NAME.test(k) || typeof v !== 'string') {
          problems.push(`${where}: env "${k}" left out (a variable name and a text value)`);
          continue;
        }
        env[k] = expandHome(v, home);
      }
    }
    const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [];
    const plain = !Object.keys(env).length && !args.length && name === agentTitle(kind);
    profiles.push({ name, kind, env, args, slug, plain });
  });
  return { profiles, problems };
}

/**
 * One row of the herdr.agents table (the Settings page edits it as name → value): the value is the agent,
 * then its variables, e.g. `claude CLAUDE_CONFIG_DIR=~/.claude-work`. Undefined, with why, when it isn't.
 */
export function parseProfileSpec(spec: string): { kind: string; env: Record<string, string> } | { problem: string } {
  const [kind, ...vars] = spec.trim().split(/\s+/).filter(Boolean);
  if (!kind || kind.includes('=')) {
    return { problem: 'starts with the agent (claude, codex, kiro, …), then NAME=value variables' };
  }
  const env: Record<string, string> = {};
  for (const v of vars) {
    const eq = v.indexOf('=');
    const name = v.slice(0, eq);
    if (eq <= 0 || !ENV_NAME.test(name)) {
      return { problem: `"${v}" isn't a NAME=value variable` };
    }
    env[name] = v.slice(eq + 1);
  }
  return { kind, env };
}

/**
 * herdr.agents as the list's rows, as written: the table is the whole list (a row whose value is empty is skipped).
 * Not set yet: the defaults. The old herdr.agents list of agent kinds is read as startingTable() turns it.
 */
export function readAgentList(user: unknown, home: string, defaults: Record<string, string> = DEFAULT_AGENTS): { profiles: AgentProfile[]; problems: string[] } {
  let table: Record<string, unknown> = { ...defaults };
  if (Array.isArray(user)) {
    table = startingTable(user, undefined, defaults);
  } else if (user && typeof user === 'object') {
    table = user as Record<string, unknown>;
  }
  const entries: unknown[] = [];
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(table)) {
    if (spec === '' || spec === null) {
      continue; // taken off the list
    }
    if (typeof spec !== 'string') {
      problems.push(`herdr.agents["${name}"]: the value must be text, like "claude CLAUDE_CONFIG_DIR=~/.claude-work"`);
      continue;
    }
    const parsed = parseProfileSpec(spec);
    if ('problem' in parsed) {
      problems.push(`herdr.agents["${name}"]: ${parsed.problem}`);
      continue;
    }
    entries.push({ name, kind: parsed.kind, env: parsed.env });
  }
  const read = readAgentProfiles(entries, home);
  return { profiles: read.profiles, problems: [...problems, ...read.problems] };
}

/**
 * The list to write into the user settings once, so the Settings page shows every row as yours: it can't rename or
 * delete a setting's default rows (editing one adds a row next to it). The defaults, with what you have already:
 * - rows of yours (`agents`, a table): a default you renamed (your row whose value is just that agent, which is
 *   all the Settings page saves) takes its place; a value set to empty takes it off; the rest come after;
 * - the old herdr.agents list of agent kinds: those agents, in that order;
 * - the old herdr.agentProfiles (`oldProfiles`): its table, or its list of {name, kind, env} objects.
 */
export function startingTable(agents: unknown, oldProfiles: unknown, defaults: Record<string, string> = DEFAULT_AGENTS): Record<string, string> {
  const table: Record<string, string> = {};
  if (Array.isArray(agents)) {
    for (const kind of agents.filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim())) {
      table[agentTitle(kind)] = kind;
    }
  } else {
    const mine: Record<string, unknown> = {};
    if (agents && typeof agents === 'object') {
      Object.assign(mine, agents);
    }
    const plain = (v: unknown) => typeof v === 'string' && !!v.trim() && !/\s/.test(v.trim()) && !v.includes('=');
    for (const [name, spec] of Object.entries(defaults)) {
      if (name in mine) {
        if (typeof mine[name] === 'string' && mine[name]) {
          table[name] = mine[name] as string;
        }
        continue;
      }
      const renames = Object.keys(mine).filter((n) => !(n in table) && !(n in defaults) && plain(mine[n]) && String(mine[n]).trim() === spec);
      if (!renames.length) {
        table[name] = spec;
      }
      for (const n of renames) {
        table[n] = String(mine[n]);
      }
    }
    for (const [name, spec] of Object.entries(mine)) {
      if (!(name in table) && !(name in defaults) && typeof spec === 'string' && spec) {
        table[name] = spec;
      }
    }
  }
  if (Array.isArray(oldProfiles)) {
    Object.assign(table, profileTable(oldProfiles));
  } else if (oldProfiles && typeof oldProfiles === 'object') {
    for (const [name, spec] of Object.entries(oldProfiles as Record<string, unknown>)) {
      if (typeof spec === 'string' && spec) {
        table[name] = spec;
      }
    }
  }
  return table;
}

/** The old list format as table rows (name → "agent NAME=value …"), to save it in the format the Settings page edits. */
function profileTable(list: unknown[]): Record<string, string> {
  const table: Record<string, string> = {};
  for (const entry of list) {
    const e = entry as { name?: unknown; kind?: unknown; env?: unknown } | null;
    if (!e || typeof e.name !== 'string' || !e.name.trim()) {
      continue;
    }
    const parts = [kindOf(e.kind)];
    if (e.env && typeof e.env === 'object') {
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        if (typeof v === 'string' && !/\s/.test(v)) {
          parts.push(`${k}=${v}`);
        }
      }
    }
    table[e.name.trim()] = parts.join(' ');
  }
  return table;
}

/** The profile an agent was started with, from its name in Herdr ("claude-work" or "claude-work-2"). */
export function profileOfAgent(profiles: readonly AgentProfile[], agentName: string | undefined): AgentProfile | undefined {
  if (!agentName) {
    return undefined;
  }
  return profiles.find((p) => !p.plain && (agentName === p.slug || new RegExp(`^${p.slug.replace(/[-_]/g, '\\$&')}-\\d+$`).test(agentName)));
}
