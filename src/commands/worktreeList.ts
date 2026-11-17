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
}

/**
 * Where Herdr puts the worktrees it creates, one folder per repo (`~/.herdr/worktrees/<repo>/<branch>`): one
 * checkout of each, since worktree.list from any checkout lists the whole repo. That finds a repo whose
 * spaces are all closed.
 */
export function herdrWorktreeFolders(home: string): string[] {
  const root = path.join(home, '.herdr', 'worktrees');
  const found: string[] = [];
  for (const repo of readDirs(root)) {
    const [first] = readDirs(path.join(root, repo));
    if (first) {
      found.push(path.join(root, repo, first));
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
  for (const f of herdrFolders) {
    if (!folders.includes(f)) {
      folders.push(f);
    }
  }
  return folders;
}

/**
 * The linked worktrees without a space, each once, by repo then branch. Skipped: the repo's own checkout, bare
 * repos, and prunable ones (git's word for a worktree whose folder is gone).
 */
export function closedWorktrees(lists: WorktreeListResult[]): ClosedWorktree[] {
  const out: ClosedWorktree[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const w of list.worktrees) {
      if (!w.is_linked_worktree || w.is_bare || w.is_prunable || w.open_workspace_id || seen.has(w.path)) {
        continue;
      }
      seen.add(w.path);
      out.push({ path: w.path, branch: w.branch ?? undefined, repoName: list.source.repo_name, repoFolder: list.source.source_checkout_path });
    }
  }
  return out.sort((a, b) => a.repoName.localeCompare(b.repoName) || worktreeLabel(a).localeCompare(worktreeLabel(b)));
}

/** The space name a reopened worktree gets: its branch, like New Worktree…, else its folder's name. */
export function worktreeLabel(w: ClosedWorktree): string {
  return w.branch ?? path.basename(w.path);
}
