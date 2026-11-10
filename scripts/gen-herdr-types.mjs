#!/usr/bin/env node
// Generates src/herdrTypes.ts from Herdr's own JSON Schema.
//
//   node scripts/gen-herdr-types.mjs                # runs `herdr api schema --json`
//   node scripts/gen-herdr-types.mjs schema.json    # or reads a saved schema
//
// Only the types reachable from ROOTS / RESULT_VARIANTS are emitted. Add a root here when the
// extension starts using another part of the API, then re-run (npm run gen:types).
// ROOTS are keyed by schema section: success_response (results) and request (method params).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = {
  success_response: ['SessionSnapshot', 'PaneProcessInfo', 'PaneReadResult'],
  request: [
    'WorkspaceCreateParams',
    'WorkspaceRenameParams',
    'WorkspaceCloseParams',
    'WorktreeCreateParams',
    'WorktreeRemoveParams',
    'TabCreateParams',
    'TabRenameParams',
    'TabTarget',
    'AgentStartParams',
    'PaneRenameParams',
    'PaneTarget',
    'AgentRenameParams',
    'EventsSubscribeParams',
    'PaneSplitParams',
    'AgentPromptParams',
  ],
};
/** `ResponseResult` variants (discriminated by `type`) to emit as `<Pascal>Result` interfaces
 *  (`<Pascal>Response` when that name is already a schema type, e.g. pane_read -> PaneReadResponse). */
const RESULT_VARIANTS = [
  'session_snapshot',
  'pane_process_info',
  'pane_read',
  'workspace_created',
  'tab_created',
  'worktree_created',
  'worktree_removed',
  'agent_started',
  'pane_info',
  'agent_prompted',
  'agent_manifest_status',
  'ok',
];

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'herdrTypes.ts');

const herdr = (...args) => execFileSync('herdr', args, { encoding: 'utf8' });
const schemaArg = process.argv[2];
const root = JSON.parse(schemaArg ? readFileSync(schemaArg, 'utf8') : herdr('api', 'schema', '--json'));
let version = 'unknown';
try {
  version = herdr('--version').trim().replace(/^herdr\s+/, '');
} catch {}

const defs = root.schemas.success_response.$defs;
const pascal = (s) => s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

/** Types to emit, by name. Sections share some names (AgentStatus, SplitDirection): they must agree. */
const queue = [];
const found = new Map();
const want = (sectionName, name) => {
  const def = root.schemas[sectionName]?.$defs?.[name];
  if (!def) throw new Error(`no ${sectionName} type ${name}`);
  const seen = found.get(name);
  if (seen) {
    if (JSON.stringify(strip(seen)) !== JSON.stringify(strip(def))) throw new Error(`${name} differs between schema sections`);
    return name;
  }
  found.set(name, def);
  queue.push(name);
  return name;
};
/** A definition without section-specific $ref prefixes, for comparing across sections. */
const strip = (d) => JSON.parse(JSON.stringify(d).replace(/#\/schemas\/[a-z_]+\/\$defs\//g, ''));
// "#/schemas/<section>/$defs/<Name>"
const refName = (ref) => {
  const m = /^#\/schemas\/([a-z_]+)\/\$defs\/(\w+)$/.exec(ref);
  if (!m) throw new Error(`unresolved $ref ${ref}`);
  return want(m[1], m[2]);
};
for (const [sectionName, names] of Object.entries(ROOTS)) for (const n of names) want(sectionName, n);

const lit = (v) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v));
const paren = (t) => (/[|&]/.test(t) ? `(${t})` : t);
const PRIM = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' };

function ts(s, indent) {
  if (s.$ref) return refName(s.$ref);
  if ('const' in s) return lit(s.const);
  if (s.enum) return s.enum.map(lit).join(' | ');
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return [...new Set(alts.map((a) => ts(a, indent)))].join(' | ');
  if (Array.isArray(s.type)) return s.type.map((t) => ts({ ...s, type: t }, indent)).join(' | ');
  if (s.type === 'array') return `${paren(ts(s.items ?? {}, indent))}[]`;
  if (s.type === 'object') {
    if (s.properties) return objectBody(s, indent);
    if (s.additionalProperties && typeof s.additionalProperties === 'object')
      return `Record<string, ${ts(s.additionalProperties, indent)}>`;
    return 'Record<string, unknown>';
  }
  return PRIM[s.type] ?? 'unknown';
}

function doc(s, pad) {
  const notes = [s.description, s.format && `format: ${s.format}`, 'default' in s && `default: ${JSON.stringify(s.default)}`].filter(Boolean);
  return notes.length ? `${pad}/** ${notes.join(' · ')} */\n` : '';
}

function objectBody(s, indent) {
  const pad = '  '.repeat(indent + 1);
  const req = new Set(s.required ?? []);
  const lines = Object.entries(s.properties).map(
    ([k, v]) => `${doc(v, pad)}${pad}${k}${req.has(k) ? '' : '?'}: ${ts(v, indent + 1)};`,
  );
  return `{\n${lines.join('\n')}\n${'  '.repeat(indent)}}`;
}

const emit = (name, s) =>
  doc(s, '') +
  (s.type === 'object' && s.properties
    ? `export interface ${name} ${objectBody(s, 0)}\n`
    : `export type ${name} = ${ts(s, 0)};\n`);

const blocks = [];
const variants = defs.ResponseResult.oneOf ?? defs.ResponseResult.anyOf;
for (const v of RESULT_VARIANTS) {
  const s = variants.find((x) => x.properties?.type?.const === v);
  if (!s) throw new Error(`ResponseResult has no variant "${v}"`);
  blocks.push(emit(defs[`${pascal(v)}Result`] ? `${pascal(v)}Response` : `${pascal(v)}Result`, s));
}
for (let i = 0; i < queue.length; i++) blocks.push(emit(queue[i], found.get(queue[i])));

writeFileSync(
  out,
  `// GENERATED by scripts/gen-herdr-types.mjs from \`herdr api schema --json\` — do not edit by hand.
// herdr ${version} · protocol ${root.protocol} · schema_version ${root.schema_version}
// Regenerate after upgrading Herdr: npm run gen:types

export const HERDR_PROTOCOL = ${root.protocol};

${blocks.join('\n')}`,
);
console.log(`wrote ${out} (${queue.length + RESULT_VARIANTS.length} types, herdr ${version}, protocol ${root.protocol})`);
