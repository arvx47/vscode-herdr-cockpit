// Agent kinds and names, whichever driver starts them: display names (AGENT_KINDS), the names agents get
// (AGENT_NAME, the pattern Herdr checks; agentName(), agentSlug()) and the arguments that resume a conversation.
// No vscode imports.

import type { AgentSessionInfo } from '../drivers/herdr/herdrTypes';

/** Agent kinds `herdr agent start --kind` accepts (herdr 0.9.1), with display names. */
export const AGENT_KINDS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kiro: 'Kiro',
  cursor: 'Cursor',
  gemini: 'Gemini',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  amp: 'Amp',
  agy: 'Antigravity',
  cline: 'Cline',
  devin: 'Devin',
  droid: 'Droid',
  grok: 'Grok',
  hermes: 'Hermes',
  kilo: 'Kilo Code',
  kimi: 'Kimi',
  mastracode: 'Mastra Code',
  qodercli: 'Qoder',
  qwen: 'Qwen',
  pi: 'Pi',
  omp: 'omp',
  letta: 'Letta',
  maki: 'Maki',
  muse: 'Muse',
};

/** Herdr's rule for agent names (they double as CLI targets): lowercase, digits, - and _. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** A valid agent name from any text ("Reviewer Bot" -> "reviewer-bot"); undefined when nothing usable is left. */
export function agentSlug(text: string): string | undefined {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  if (!AGENT_NAME.test(s)) {
    return undefined;
  }
  return s;
}

/** A free agent name for a new agent of this kind: "claude", then "claude-2", "claude-3", ... */
export function agentName(kind: string, taken: Iterable<string>): string {
  const base = kind.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 28) || 'agent';
  const used = new Set(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    if (!used.has(`${base}-${n}`)) {
      return `${base}-${n}`;
    }
  }
}

/** "claude" -> "Claude"; unknown kinds are title-cased. */
export const agentTitle = (kind: string) => AGENT_KINDS[kind.toLowerCase()] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

/**
 * The arguments that make an agent resume its own conversation, from the session Herdr stored for it
 * (agent_session). Only agents whose CLI resumes by id; undefined means the agent starts a fresh one.
 */
export function resumeArgs(kind: string | undefined, session: AgentSessionInfo | null | undefined): string[] | undefined {
  if (!session || session.kind !== 'id' || !session.value) {
    return undefined;
  }
  const k = kind?.toLowerCase();
  if (k === 'claude') {
    return ['--resume', session.value];
  }
  if (k === 'codex') {
    return ['resume', session.value];
  }
  return undefined;
}
