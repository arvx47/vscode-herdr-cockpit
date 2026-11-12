// The branch name for a new worktree space, from what you type: a name, a ticket key, or a ticket's link.
// No vscode imports (test/noticesTest.ts).

/**
 * A ticket link (Jira's `…/browse/OUT-9656`, or a link ending in the key) becomes its key; anything else is
 * the name as typed, trimmed.
 */
export function branchFromInput(text: string): string {
  const t = text.trim();
  const key = /^https?:\/\/\S*?\b([A-Z][A-Z0-9]+-\d+)\b\S*$/.exec(t);
  if (key) {
    return key[1];
  }
  return t;
}

/** Why git wouldn't accept this as a new branch name (see git check-ref-format), or undefined when it would. */
export function branchProblem(name: string): string | undefined {
  if (!name) {
    return 'Enter a branch name';
  }
  if (/\s|\.\.|[~^:?*[\\]|@\{|\/\/|\.lock$|\.lock\/|\/\.|^\./.test(name) || /^[-/]|[/.]$/.test(name) || name === '@') {
    return 'Not a valid git branch name';
  }
  return undefined;
}
