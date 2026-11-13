// "Herdr Cockpit: How to Read the Sidebar": a user-facing guide in an editor tab (media/help.html).
// Reuses the sidebar's stylesheet so its examples look exactly like the real sidebar,
// and lists the extension's settings straight from package.json so they never drift.
import * as vscode from 'vscode';
import { EXTENSION_NAME } from './brand';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Commands the page's buttons may run. */
const ALLOWED = new Set(['openSettings', 'setupHub', 'refresh', 'startServer', 'installPlugin']);

let current: vscode.WebviewPanel | undefined;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** package.json's texts live in package.nls.json ("%key%"); the editor usually hands them over filled in already. */
function nlsText(ext: vscode.Extension<unknown>, value: string | undefined): string | undefined {
  const key = /^%(.+)%$/.exec(value ?? '')?.[1];
  if (!key) {
    return value;
  }
  try {
    const nls = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.nls.json'), 'utf8')) as Record<string, string>;
    return nls[key] ?? value;
  } catch {
    return value;
  }
}

function settingsTable(ext: vscode.Extension<unknown>): string {
  const props: Record<string, { description?: string; markdownDescription?: string; default?: unknown }> =
    (ext.packageJSON as any)?.contributes?.configuration?.properties ?? {};
  const rows = Object.entries(props)
    .map(
      ([key, p]) =>
        `<tr><td>${esc(key)}<div class="def">default: ${esc(JSON.stringify(p.default ?? ''))}</div></td><td>${esc(nlsText(ext, p.description ?? p.markdownDescription) ?? '')}</td></tr>`,
    )
    .join('');
  return `<table class="settings"><tr><th>Setting</th><th>What it does</th></tr>${rows}</table>`;
}

export function showHelp(ctx: vscode.ExtensionContext) {
  if (current) return current.reveal();
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('herdr.help', `${EXTENSION_NAME}: Sidebar Guide`, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [media],
  });
  current = panel;
  panel.iconPath = vscode.Uri.joinPath(media, 'herdr.svg');
  const w = panel.webview;
  const uri = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
  const nonce = crypto.randomBytes(16).toString('base64');
  const palette = process.platform === 'darwin' ? '<kbd>⇧</kbd><kbd>⌘</kbd><kbd>P</kbd>' : '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>';
  const body = fs
    .readFileSync(vscode.Uri.joinPath(media, 'help.html').fsPath, 'utf8')
    .replace('<!--SETTINGS-->', settingsTable(ctx.extension))
    .replace(/<!--PALETTE-->/g, palette);
  w.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; img-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('codicons', 'codicon.css')}" rel="stylesheet">
<link href="${uri('panel.css')}" rel="stylesheet">
<link href="${uri('help.css')}" rel="stylesheet">
<title>${EXTENSION_NAME} sidebar guide</title>
</head>
<body><main class="doc">${body}</main>
<script nonce="${nonce}" src="${uri('agent-icons.js')}"></script>
<script nonce="${nonce}" src="${uri('help.js')}"></script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((m) => {
    if (m?.type === 'cmd' && ALLOWED.has(m.command)) vscode.commands.executeCommand(`herdr.${m.command}`);
  });
  panel.onDidDispose(() => (current = undefined));
}
