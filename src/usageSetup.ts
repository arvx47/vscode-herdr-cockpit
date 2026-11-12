// Opt-in: let Claude Code share its plan usage (5-hour / weekly limits) with the sidebar.
// Claude Code only gives `rate_limits` to a status-line command, so this installs a tiny one
// (src/usage.ts claudeStatusLineScript) in ~/.claude/settings.json, after asking.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { errorText } from './herdrClient';
import { claudeCaptureFile, claudeStatusLineScript, hasCapture, shQuote, wrapStatusLine } from './usage';

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

/** The capture script, written (again) next to the capture file. */
async function writeScript(capture: string): Promise<string> {
  const script = path.join(path.dirname(capture), 'claude-statusline.sh');
  await fs.promises.mkdir(path.dirname(capture), { recursive: true });
  await fs.promises.writeFile(script, claudeStatusLineScript(capture), { mode: 0o755 });
  return script;
}

/**
 * You already have a status line: never replace it. Offer to put the capture in front of it (it saves only the
 * plan limits and passes Claude Code's input on unchanged, so your status line shows what it always did), or
 * copy the new command to paste yourself.
 */
async function addToExistingStatusLine(settingsFile: string, capture: string, log: (m: string) => void): Promise<boolean> {
  const before = await readSettings(settingsFile);
  const statusLine = before?.statusLine as { type?: unknown; command?: unknown } | undefined;
  if (!before || !statusLine) {
    return false;
  }
  if (statusLine.type !== 'command' || typeof statusLine.command !== 'string') {
    vscode.window.showInformationMessage(
      "Herdr: Claude Code's status line here isn't a command, so Herdr can't read plan limits through it. Remove \"statusLine\" from ~/.claude/settings.json and try again.",
    );
    return false;
  }
  const script = path.join(path.dirname(capture), 'claude-statusline.sh');
  if (hasCapture(statusLine.command, script)) {
    await writeScript(capture);
    vscode.window.showInformationMessage('Herdr: your status line already saves plan limits. They appear after the next Claude reply.');
    return true;
  }
  const wrapped = wrapStatusLine(statusLine.command, script);
  // Status lines written by other tools can be very long: the dialog shows how it starts.
  const short = (c: string) => {
    if (c.length <= 140) {
      return c;
    }
    return `${c.slice(0, 140)}…`;
  };
  // Another tool's status line (its hooks folder, ~/.<tool>/…, in the command): say who, since it may rewrite it.
  const tool = /\/\.([a-z][\w-]*)\/[^\s"']*statusline/i.exec(statusLine.command)?.[1];
  let whose = 'Yours';
  let rewrite = '';
  if (tool) {
    whose = `Yours was set up by another app, ${tool} (it keeps its files in ~/.${tool}), and`;
    rewrite =
      `\n\nIf ${tool} rewrites the status line later, plan limits stop updating: click Show plan limits… again then. If you don't ` +
      `use ${tool} anymore, Use Herdr's Instead replaces its status line with Herdr's, which also shows the two numbers under the prompt.`;
  }
  const buttons = ['Add It for Me', 'Copy New Command'];
  if (tool) {
    buttons.push("Use Herdr's Instead");
  }
  const pick = await vscode.window.showInformationMessage(
    'Add plan limits to your Claude Code status line?',
    {
      modal: true,
      detail:
        'Claude Code shares your plan limits (the 5-hour and weekly percentages) only with its "status line": a command, set in ' +
        `~/.claude/settings.json, that Claude Code runs to draw the line under its prompt. ${whose} Herdr won't replace it.\n\n` +
        'Click Add It for Me and Herdr makes one change in that file for you, nothing to edit by hand: it puts a small step in front of ' +
        'the command that saves just those two numbers for the sidebar, then runs the command exactly as before. A backup of the ' +
        `file is saved next to it first (settings.json.herdr-backup).${rewrite}\n\n` +
        `The command starts with:\n${short(statusLine.command)}\n\n` +
        "Copy New Command only copies the changed command, if you'd rather paste it into the file yourself.",
    },
    ...buttons,
  );
  if (!pick) {
    return false;
  }
  try {
    await writeScript(capture);
    if (pick === 'Copy New Command') {
      await vscode.env.clipboard.writeText(wrapped);
      vscode.window.showInformationMessage('Herdr: copied. In ~/.claude/settings.json, replace "command" under "statusLine" with it.');
      return false;
    }
    // Read it again: Claude Code may have saved its own changes while the question was open.
    const settings = await readSettings(settingsFile);
    const now = settings?.statusLine as { command?: unknown } | undefined;
    if (!settings || now?.command !== statusLine.command) {
      vscode.window.showWarningMessage('Herdr: your status line changed meanwhile, so Herdr left it alone. Try again.');
      return false;
    }
    await fs.promises.copyFile(settingsFile, `${settingsFile}.herdr-backup`);
    if (pick === "Use Herdr's Instead") {
      settings.statusLine = { type: 'command', command: `sh ${shQuote(script)}` };
    } else {
      settings.statusLine = { ...(settings.statusLine as object), command: wrapped };
    }
    await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    let what = 'capture added in front of the existing status line';
    if (pick === "Use Herdr's Instead") {
      what = "the existing status line replaced with Herdr's";
    }
    log(`claude usage: ${what}; backup at ${settingsFile}.herdr-backup`);
    vscode.window.showInformationMessage('Herdr: done. Claude plan limits appear after the next Claude reply.');
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Herdr: couldn't update the status line: ${errorText(e)}`);
    return false;
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
    return addToExistingStatusLine(settingsFile, capture, log);
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
    return addToExistingStatusLine(settingsFile, capture, log);
  }
  try {
    const script = await writeScript(capture);
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
