// Opt-in: let Claude Code share its plan usage (5-hour / weekly limits) with the sidebar.
// Claude Code only gives `rate_limits` to a status-line command, so this installs a tiny one
// (src/usage.ts claudeStatusLineScript) in ~/.claude/settings.json, after asking.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { errorText } from './herdrClient';
import { claudeCaptureFile, claudeStatusLineScript, shQuote } from './usage';

/**
 * Claude Code's settings as an object ({} when the file doesn't exist). Undefined, after saying why, when it
 * can't be read or isn't a JSON object: then nothing is written.
 */
async function readSettings(settingsFile: string): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
  } catch (e) {
    if ((e as { code?: unknown } | undefined)?.code === 'ENOENT') {
      return {};
    }
    vscode.window.showErrorMessage(`Herdr: couldn't read ${settingsFile}: ${errorText(e)}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    vscode.window.showErrorMessage(`Herdr: ${settingsFile} isn't a JSON object, so Herdr left it alone.`);
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** Never replace someone's status line; show how to add the capture to it instead. */
async function explainExistingStatusLine(capture: string) {
  const snippet = `tee ${shQuote(capture)} | `;
  const pick = await vscode.window.showInformationMessage(
    'You already have a Claude Code status line, so Herdr left it alone.',
    {
      modal: true,
      detail: `To show plan limits in the sidebar, make your status line command also save its input: put ${snippet}in front of the command in ~/.claude/settings.json ("statusLine" → "command").`,
    },
    'Copy Snippet',
  );
  if (pick) {
    await vscode.env.clipboard.writeText(snippet);
  }
}

export async function setUpClaudeUsage(home: string, log: (m: string) => void): Promise<boolean> {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const capture = claudeCaptureFile(home);
  const before = await readSettings(settingsFile);
  if (!before) {
    return false;
  }
  if (before.statusLine) {
    await explainExistingStatusLine(capture);
    return false;
  }

  const ok = await vscode.window.showInformationMessage(
    'Show Claude plan limits in the Herdr sidebar?',
    {
      modal: true,
      detail:
        'Claude Code shares your 5-hour and weekly usage only with a status line command. Herdr will add a small one to ' +
        '~/.claude/settings.json (a backup is saved next to it) that shows "5h 42% · 7d 18%" under the Claude prompt and saves ' +
        `the numbers to ${capture}. With a custom status line, Claude Code hides some footer hints such as "? for shortcuts".\n\n` +
        'Limits appear for claude.ai Pro and Max plans, after the next reply in each session. To undo, remove "statusLine" from the settings file.',
    },
    'Set Up',
  );
  if (!ok) return false;

  // Read it again: Claude Code may have saved its own changes while the question was open.
  const settings = await readSettings(settingsFile);
  if (!settings) {
    return false;
  }
  if (settings.statusLine) {
    await explainExistingStatusLine(capture);
    return false;
  }
  try {
    const script = path.join(path.dirname(capture), 'claude-statusline.sh');
    await fs.promises.mkdir(path.dirname(capture), { recursive: true });
    await fs.promises.writeFile(script, claudeStatusLineScript(capture), { mode: 0o755 });
    if (fs.existsSync(settingsFile)) await fs.promises.copyFile(settingsFile, `${settingsFile}.herdr-backup`);
    else await fs.promises.mkdir(path.dirname(settingsFile), { recursive: true });
    settings.statusLine = { type: 'command', command: `sh ${shQuote(script)}` };
    await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    log(`claude usage: status line installed (${script}); backup at ${settingsFile}.herdr-backup`);
    vscode.window.showInformationMessage('Herdr: done. Claude plan limits appear after the next Claude reply.');
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: couldn't set up the status line: ${errorText(e)}`);
    return false;
  }
}
