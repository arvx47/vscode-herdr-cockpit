// "Review changes" for a space/agent: list the changes in the agent's repo and open each as a diff.
// Uncommitted changes are HEAD <-> working tree. On a git worktree branch (a space made with "New git
// worktree of…"), the agent usually commits as it goes, so the review starts from where the branch left
// the main branch: merge-base <-> working tree, committed and uncommitted together.
// Uses VS Code's built-in git extension, which only runs git in trusted windows.
import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './brand';
import * as path from 'path';

// Subset of the vscode.git API (extensions/git/src/api/git.d.ts) we rely on.
const enum Status {
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  DELETED = 6,
  UNTRACKED = 7,
}
interface Change {
  uri: vscode.Uri;
  originalUri?: vscode.Uri;
  status: number;
}
interface Repository {
  rootUri: vscode.Uri;
  state: { indexChanges: Change[]; workingTreeChanges: Change[]; untrackedChanges?: Change[] };
  status(): Promise<void>;
  getMergeBase?(ref1: string, ref2: string): Promise<string | undefined>;
  diffWith?(ref: string): Promise<Change[]>;
}
interface GitAPI {
  getRepository(uri: vscode.Uri): Repository | null;
  openRepository?(uri: vscode.Uri): Promise<Repository | null>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

/** Where a worktree branch usually comes from, in the order they're tried. */
const BASE_BRANCHES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

async function gitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<any>('vscode.git');
  if (!ext) return;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports?.getAPI?.(1);
}

const LETTER: Record<number, string> = { 0: 'M', 1: 'A', 2: 'D', 3: 'R', 5: 'M', 6: 'D', 7: 'U' };

/** What the diffs compare against: HEAD, or the commit the branch started from. */
interface Base {
  ref: string;
  /** Shown in diff titles: "HEAD", or the base branch ("main"). */
  name: string;
}

async function openChange(git: GitAPI, c: Change, base: Base, preview: boolean) {
  const name = path.basename(c.uri.fsPath);
  if (c.status === Status.UNTRACKED || c.status === Status.INDEX_ADDED) {
    await vscode.commands.executeCommand('vscode.open', c.uri, { preview });
  } else if (c.status === Status.DELETED || c.status === Status.INDEX_DELETED) {
    await vscode.commands.executeCommand('vscode.open', git.toGitUri(c.uri, base.ref), { preview });
  } else {
    // A renamed file's old content is at its old path.
    let before = c.uri;
    if (c.status === Status.INDEX_RENAMED && c.originalUri) {
      before = c.originalUri;
    }
    await vscode.commands.executeCommand('vscode.diff', git.toGitUri(before, base.ref), c.uri, `${name} (${base.name} ↔ agent)`, { preview });
  }
}

/** The commit a worktree branch left its base branch at, when it has commits of its own. */
async function branchStart(repo: Repository): Promise<Base | undefined> {
  if (!repo.getMergeBase || !repo.diffWith) {
    return undefined;
  }
  for (const branch of BASE_BRANCHES) {
    const start = await repo.getMergeBase('HEAD', branch).catch(() => undefined);
    if (!start) {
      continue;
    }
    const head = await repo.getMergeBase('HEAD', 'HEAD').catch(() => undefined);
    if (start === head) {
      return undefined; // no commits on the branch yet: uncommitted changes are everything
    }
    return { ref: start, name: branch.replace(/^origin\//, '').replace(/^HEAD$/, 'main branch') };
  }
  return undefined;
}

/** Changes listed once each (a file both staged and modified is one entry). */
function unique(changes: Change[]): Change[] {
  const seen = new Set<string>();
  return changes.filter((c) => !seen.has(c.uri.fsPath) && seen.add(c.uri.fsPath));
}

/**
 * Review an agent's changes. `worktree`: the space is a linked git worktree, so the review covers the whole
 * branch (since it left the base branch) with a choice to see only what's uncommitted.
 */
export async function reviewChanges(cwd: string | undefined, label: string, opts: { worktree?: boolean } = {}) {
  if (!cwd) {
    vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: no working directory known for ${label}.`);
    return;
  }
  const git = await gitApi();
  if (!git) {
    vscode.window.showErrorMessage(`${MESSAGE_PREFIX}: the built-in Git extension is disabled.`);
    return;
  }
  const uri = vscode.Uri.file(cwd);
  const repo = git.getRepository(uri) ?? (await git.openRepository?.(uri)) ?? null;
  if (!repo) {
    vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: ${cwd} is not inside a git repository.`);
    return;
  }
  await repo.status();
  const uncommitted = unique([...repo.state.indexChanges, ...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges ?? [])]);
  const head: Base = { ref: 'HEAD', name: 'HEAD' };
  let start: Base | undefined;
  let onBranch: Change[] = [];
  if (opts.worktree) {
    start = await branchStart(repo);
    if (start) {
      // diffWith covers committed and uncommitted changes to tracked files; new files come from the status.
      onBranch = unique([...(await repo.diffWith!(start.ref)), ...(repo.state.untrackedChanges ?? [])]);
    }
  }

  let showBranch = !!start && onBranch.length > 0;
  for (;;) {
    let changes = uncommitted;
    let base = head;
    if (showBranch && start) {
      changes = onBranch;
      base = start;
    }
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: no uncommitted changes in ${path.basename(repo.rootUri.fsPath)}.`);
      return;
    }

    type Item = vscode.QuickPickItem & { change?: Change; action?: 'all' | 'scm' | 'toggle' };
    const toggle: Item[] = [];
    if (start && onBranch.length) {
      if (showBranch) {
        toggle.push({ label: `$(git-commit) Only uncommitted changes (${uncommitted.length})`, description: 'HEAD ↔ working tree', action: 'toggle' });
      } else {
        toggle.push({ label: `$(git-branch) Whole branch since ${start.name} (${onBranch.length})`, description: 'committed and uncommitted', action: 'toggle' });
      }
    }
    const items: Item[] = [
      ...(changes.length <= 20 ? [{ label: `$(diff-multiple) Open all ${changes.length} diffs`, action: 'all' as const }] : []),
      ...toggle,
      { label: '$(source-control) Open Source Control view', action: 'scm' as const },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...changes.map((c) => ({
        label: path.relative(repo.rootUri.fsPath, c.uri.fsPath),
        description: LETTER[c.status] ?? '•',
        change: c,
      })),
    ];
    let scope = 'uncommitted';
    if (base !== head) {
      scope = `since ${base.name}`;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `Changes by ${label} — ${path.basename(repo.rootUri.fsPath)} (${scope})`,
      matchOnDescription: true,
    });
    if (!pick) return;
    if (pick.action === 'toggle') {
      showBranch = !showBranch;
      continue;
    }
    if (pick.action === 'scm') return vscode.commands.executeCommand('workbench.view.scm');
    if (pick.action === 'all') {
      for (const c of changes) await openChange(git, c, base, false);
      return;
    }
    if (pick.change) await openChange(git, pick.change, base, true);
    return;
  }
}
