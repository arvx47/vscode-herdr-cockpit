// The folders New space… offers: the editor's recently opened folders, minus the ones that would make a worktree or
// a second space. Worktrees have their own button on a repository's card. No vscode imports (test/recentFoldersTest.ts).
import * as fs from 'fs';
import * as path from 'path';

/** At most this many recent folders in the picker. */
export const MAX_RECENT = 12;

/**
 * `recent` (newest first) kept when the folder still exists, has no space yet (`spaceFolders`), isn't the
 * Cockpit window's own folder (`~/.herdr-cockpit`), and isn't a git worktree: one Herdr made
 * (`~/.herdr/worktrees/…`) or any linked checkout (its `.git` is a file pointing into `…/worktrees/`).
 */
export function recentFolders(recent: string[], spaceFolders: string[], home: string, max = MAX_RECENT): string[] {
  const taken = new Set(spaceFolders.map((f) => path.resolve(f)));
  const skipUnder = [path.join(home, '.herdr-cockpit'), path.join(home, '.herdr', 'worktrees')];
  const found: string[] = [];
  for (const f of recent) {
    if (found.length >= max) {
      break;
    }
    const dir = path.resolve(f);
    if (taken.has(dir) || found.includes(dir)) {
      continue;
    }
    if (skipUnder.some((root) => dir === root || dir.startsWith(root + path.sep))) {
      continue;
    }
    if (!isDir(dir) || isLinkedWorktree(dir)) {
      continue;
    }
    found.push(dir);
  }
  return found;
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** A linked worktree's `.git` is a file `gitdir: <repo>/.git/worktrees/<name>` (a submodule's points into `modules/`). */
function isLinkedWorktree(dir: string): boolean {
  try {
    const git = path.join(dir, '.git');
    if (!fs.statSync(git).isFile()) {
      return false;
    }
    return /[\\/]worktrees[\\/]/.test(fs.readFileSync(git, 'utf8'));
  } catch {
    return false;
  }
}
