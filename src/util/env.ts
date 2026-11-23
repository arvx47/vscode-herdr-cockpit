// The environment terminals start with, whichever driver runs them. No vscode imports.

/**
 * Like a terminal's environment, not VS Code's: the Herdr server is started with it (its panes inherit it). So:
 *  - drop VS Code / Electron variables (ELECTRON_RUN_AS_NODE breaks Electron apps started from a pane;
 *    __CFBundleIdentifier makes macOS attribute pane processes to VS Code);
 *  - stop Kiro's shell integration from wrapping every pane shell in its `kiro-cli-term` pty, which hides
 *    agents from Herdr's detection. A server started from a Kiro-wrapped terminal inherits Q_TERM and is
 *    left alone; one started from VS Code has none, so set Kiro's own opt-out, Q_TERM_DISABLED (verified:
 *    `kiro-cli _ should-figterm-launch` then exits 1, "don't launch").
 */
export function terminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(VSCODE_|ELECTRON_|APPLICATION_INSIGHTS|CHROME_|ORIGINAL_XDG_)/.test(k) || k === '__CFBundleIdentifier') {
      continue;
    }
    if ((k === 'TERM_PROGRAM' || k === 'TERM_PROGRAM_VERSION') && /vscode/i.test(env.TERM_PROGRAM ?? '')) {
      continue;
    }
    out[k] = v;
  }
  if (!out.Q_TERM) {
    out.Q_TERM_DISABLED = '1';
  }
  return out;
}
