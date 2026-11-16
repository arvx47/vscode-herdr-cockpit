// `~` in paths, both ways: the only copies (agent list, plan-limits setup, sidebar, socket paths use them).
// No vscode imports.
import * as os from 'os';
import * as path from 'path';

/** `~` and `~/…` are the home folder; anything else (including `~user/…`) is left as it is. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') {
    return home;
  }
  if (p.startsWith('~/')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/** The other way: a path in the home folder written with `~` (as dialogs and the sidebar show it). */
export function tildePath(p: string, home = os.homedir()): string {
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}
