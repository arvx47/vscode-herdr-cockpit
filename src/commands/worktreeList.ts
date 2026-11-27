// Worktrees that still exist on disk but have no space in Herdr (closed, or made outside it), for Reopen
// Worktree…. No vscode imports (test/worktreeListTest.ts).
import * as fs from 'fs';
import * as path from 'path';
import type { WorktreeListResult } from '../drivers/herdr/herdrTypes';

/** A worktree that can get a space again. */
export interface ClosedWorktree {
  path: string;
  /** Undefined on a detached checkout. */
  branch?: string;
  repoName: string;
  /** The repo's own folder: Herdr opens a worktree only from it (worktree.open refuses a linked worktree's). */
  repoFolder: string;
  /** The space Herdr has open on it, if any (linkedWorktrees() only; closedWorktrees() has none). */
  spaceId?: string;
}

/**
 * Where Herdr puts the worktrees it creates, one folder per repo (`~/.herdr/worktrees/<repo>/<branch>`): every
 * checkout of each, sorted. worktree.list from any checkout lists the whole repo (which finds a repo whose spaces
 * are all closed), so the first is asked and, when it fails (a folder git already pruned, or a leftover that isn't
 * a checkout), the next.
 */
export function herdrWorktreeRepos(home: string): string[][] {
  const root = path.join(home, '.herdr', 'worktrees');
  const found: string[][] = [];
  for (const repo of readDirs(root)) {
    const checkouts = readDirs(path.join(root, repo)).map((name) => path.join(root, repo, name));
    if (checkouts.length) {
      found.push(checkouts);
    }
  }
  return found;
}

function readDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The folders to ask worktree.list about: the spaces' (one per repo when Herdr says which) and Herdr's own. */
export function worktreeListFolders(spaces: { cwd?: string; worktree?: { repo_key: string } }[], herdrFolders: string[]): string[] {
  const folders: string[] = [];
  const repos = new Set<string>();
  for (const s of spaces) {
    if (!s.cwd || folders.includes(s.cwd)) {
      continue;
    }
    if (s.worktree) {
      if (repos.has(s.worktree.repo_key)) {
        continue;
      }
      repos.add(s.worktree.repo_key);
    }
    folders.push(s.cwd);
  }
  // Herdr's folder of a repo a worktree space already lives in (~/.herdr/worktrees/<repo>/…) is that repo again.
  const covered = new Set(spaces.filter((s) => s.cwd && s.worktree).map((s) => path.dirname(s.cwd!)));
  for (const f of herdrFolders) {
    if (!folders.includes(f) && !covered.has(path.dirname(f))) {
      folders.push(f);
    }
  }
  return folders;
}

/**
 * Every linked worktree, each once, by repo then branch, with the space Herdr has open on it. Skipped: the repo's
 * own checkout, bare repos, and prunable ones (git's word for a worktree whose folder is gone).
 */
export function linkedWorktrees(lists: WorktreeListResult[]): ClosedWorktree[] {
  const out: ClosedWorktree[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const w of list.worktrees) {
      if (!w.is_linked_worktree || w.is_bare || w.is_prunable || seen.has(w.path)) {
        continue;
      }
      seen.add(w.path);
      out.push({
        path: w.path,
        branch: w.branch ?? undefined,
        repoName: list.source.repo_name,
        repoFolder: list.source.source_checkout_path,
        ...(w.open_workspace_id && { spaceId: w.open_workspace_id }),
      });
    }
  }
  return out.sort((a, b) => a.repoName.localeCompare(b.repoName) || worktreeLabel(a).localeCompare(worktreeLabel(b)));
}

/** The linked worktrees without a space (linkedWorktrees() minus the open ones). */
export function closedWorktrees(lists: WorktreeListResult[]): ClosedWorktree[] {
  return linkedWorktrees(lists).filter((w) => !w.spaceId);
}

/** The space name a reopened worktree gets: its branch, like New Worktree…, else its folder's name. */
export function worktreeLabel(w: ClosedWorktree): string {
  return w.branch ?? path.basename(w.path);
}
