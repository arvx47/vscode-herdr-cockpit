// Mounts Herdr spaces as workspace folders in THIS window.
// Rule: never touch folder index 0. Changing the first folder makes VS Code restart
// every extension (including this one). We only add/remove folders at index >= 1,
// and we keep our managed folders at the tail so a swap is one atomic update.
import * as vscode from 'vscode';
import * as path from 'path';
import type { Space } from './model';

export const PREFIX = '⬢ ';

const norm = (p: string) => path.resolve(p).replace(/\/+$/, '');

function mountedPaths(): Set<string> {
  return new Set((vscode.workspace.workspaceFolders ?? []).map((f) => norm(f.uri.fsPath)));
}

export function isMounted(space: Space): boolean {
  return !!space.cwd && mountedPaths().has(norm(space.cwd));
}

function managed(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.index > 0 && f.name.startsWith(PREFIX));
}

/** VS Code requires waiting for onDidChangeWorkspaceFolders between updates. */
let pending: Promise<void> = Promise.resolve();
function update(start: number, del: number, ...add: { uri: vscode.Uri; name?: string }[]): Promise<boolean> {
  const run = pending.then(
    () =>
      new Promise<boolean>((resolve) => {
        const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => done(true));
        const timer = setTimeout(() => done(false), 4000);
        const done = (ok: boolean) => {
          sub.dispose();
          clearTimeout(timer);
          resolve(ok);
        };
        if (!vscode.workspace.updateWorkspaceFolders(start, del, ...add)) done(false);
      }),
  );
  pending = run.then(() => undefined);
  return run;
}

export type MountResult = 'mounted' | 'already' | 'no-window' | 'no-cwd' | 'failed';

/**
 * Show a space in this window. pin=false swaps out other managed spaces;
 * pin=true mounts it alongside them.
 */
export async function mountSpace(space: Space, pin: boolean): Promise<MountResult> {
  if (!space.cwd) return 'no-cwd';
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return 'no-window';

  const target = norm(space.cwd);
  const others = managed().filter((f) => norm(f.uri.fsPath) !== target);
  const alreadyThere = folders.some((f) => norm(f.uri.fsPath) === target);

  if (alreadyThere && (pin || others.length === 0)) return 'already';

  const add = alreadyThere ? [] : [{ uri: vscode.Uri.file(space.cwd), name: PREFIX + space.label }];

  if (pin || others.length === 0) {
    return (await update(folders.length, 0, ...add)) ? 'mounted' : 'failed';
  }

  // Swap: managed folders normally sit at the tail. If they do, replace the tail in one call.
  const start = Math.min(...others.map((f) => f.index));
  const tail = folders.slice(start);
  const tailIsRemovable = tail.every(
    (f) => others.includes(f) || (alreadyThere && norm(f.uri.fsPath) === target),
  );
  if (tailIsRemovable && start > 0) {
    const targetInTail = tail.some((f) => norm(f.uri.fsPath) === target);
    const keepTarget = !alreadyThere
      ? add
      : targetInTail
        ? [{ uri: vscode.Uri.file(space.cwd), name: PREFIX + space.label }]
        : [];
    return (await update(start, tail.length, ...keepTarget)) ? 'mounted' : 'failed';
  }

  // The user rearranged folders; remove ours one by one (highest index first), then add.
  for (const f of [...others].sort((a, b) => b.index - a.index)) {
    const current = (vscode.workspace.workspaceFolders ?? []).find((x) => x.uri.fsPath === f.uri.fsPath);
    if (current && current.index > 0) await update(current.index, 1);
  }
  if (add.length) {
    const n = vscode.workspace.workspaceFolders?.length ?? 0;
    return (await update(n, 0, ...add)) ? 'mounted' : 'failed';
  }
  return 'mounted';
}

export async function unmountSpace(space: Space): Promise<void> {
  if (!space.cwd) return;
  const f = (vscode.workspace.workspaceFolders ?? []).find((x) => norm(x.uri.fsPath) === norm(space.cwd!));
  if (f && f.index > 0) await update(f.index, 1);
}
