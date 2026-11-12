// The wording of notifications built from plain values (extension.ts shows them), so it's unit-tested. No vscode imports.
import * as path from 'path';
import type { DownReason } from './connection';

/** One line per reason Herdr is unreachable (status bar, menus). */
export const DOWN_TEXT: Record<DownReason, string> = {
  'not-installed': "Herdr isn't installed.",
  'not-running': "Herdr isn't running.",
  crashed: 'Herdr stopped unexpectedly.',
  incompatible: "This Herdr version isn't compatible with Herdr Cockpit.",
  unreachable: "Herdr is running but isn't answering.",
};

/** An editor selection, as far as fileReference() needs it (lines and characters count from 0). */
export interface LineSelection {
  isEmpty: boolean;
  start: { line: number };
  end: { line: number; character: number };
}

/** `src/app.ts:12-30` for a selection, relative to the agent's folder when the file is inside it. */
export function fileReference(file: string, sel: LineSelection, agentCwd: string | undefined): string {
  let shown = file;
  if (agentCwd) {
    const rel = path.relative(agentCwd, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      shown = rel;
    }
  }
  if (sel.isEmpty) {
    return shown;
  }
  let last = sel.end.line;
  // A selection ending at the start of a line doesn't include that line.
  if (sel.end.character === 0 && last > sel.start.line) {
    last--;
  }
  if (last === sel.start.line) {
    return `${shown}:${sel.start.line + 1}`;
  }
  return `${shown}:${sel.start.line + 1}-${last + 1}`;
}

/** Herdr was connected and went away: the message, and the buttons that can help. */
export function lostNotice(reason: DownReason, detail?: string): { message: string; actions: string[] } {
  if (reason === 'crashed') {
    return { message: 'Herdr stopped unexpectedly. Your agents run inside Herdr, so they stopped too.', actions: ['Start Herdr', 'Open Herdr TUI'] };
  }
  if (reason === 'not-running') {
    return { message: 'Herdr stopped. Your agents run inside Herdr, so they stopped too.', actions: ['Start Herdr', 'Open Herdr TUI'] };
  }
  let message = 'Lost the connection to Herdr.';
  if (detail) {
    message = `Lost the connection to Herdr: ${detail}.`;
  }
  return { message, actions: ['Retry'] };
}

/** "a", "a and b", "a, b and c", "a, b and 3 more". */
export function nameList(names: readonly string[]): string {
  if (names.length === 1) {
    return names[0];
  }
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** Panes another client took over together: `who` per pane (undefined = Herdr didn't say). */
export function takenOverNotice(lost: readonly { name: string; who?: string }[]): string {
  const whos = [...new Set(lost.map((l) => l.who ?? 'another Herdr client'))];
  let who = 'other Herdr clients';
  if (whos.length === 1) {
    who = whos[0];
  }
  const list = nameList(lost.map((l) => l.name));
  if (lost.length === 1) {
    return `${who[0].toUpperCase()}${who.slice(1)} took over the Herdr pane ${list}. Its tab shows it read-only here; type in a tab to take it back.`;
  }
  return `${who[0].toUpperCase()}${who.slice(1)} took over the Herdr panes ${list}. Their tabs show them read-only here; type in a tab to take it back.`;
}
