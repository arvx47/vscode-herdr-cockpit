// Which folders a file link may open from without asking (runLink in extension.ts). No vscode imports.
import * as path from 'path';

/**
 * The folders a file link may open from without asking: open folders, spaces' and panes' folders. Not `/`, your
 * home folder or one above it (everything would be inside), nor a hidden folder in your home (`~/.ssh`, `~/.aws`:
 * a pane started there must not let a link open your keys without asking). Herdr's own `~/.herdr` stays: its
 * worktree spaces live in `~/.herdr/worktrees`.
 */
export function fileLinkRoots(candidates: readonly (string | undefined)[], home: string): string[] {
  const homeDir = path.resolve(home);
  const roots: string[] = [];
  for (const c of candidates) {
    if (!c) {
      continue;
    }
    const root = path.resolve(c);
    const fromRoot = path.relative(root, homeDir);
    // The root is home, or contains it.
    if (fromRoot === '' || (!fromRoot.startsWith('..') && !path.isAbsolute(fromRoot))) {
      continue;
    }
    const inHome = path.relative(homeDir, root);
    const top = inHome.split(path.sep)[0];
    if (!inHome.startsWith('..') && !path.isAbsolute(inHome) && top.startsWith('.') && top !== '.herdr') {
      continue;
    }
    if (!roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}
