// Herdr terminal profiles: the VS Code "+" button (and its ∨ dropdown) and "Split Terminal" creating Herdr
// panes. VS Code asks a profile provider how to launch the terminal; we answer with a built-in tab
// (builtinTerminal.ts) that creates its pane once it opens, because only then can we tell a split from a new
// tab: VS Code puts an editor-area split in a new group beside the current one (verified in VS Code 1.140's
// source: a split with a contributed default profile opens it at SIDE_GROUP). A split becomes a Herdr pane
// split (same Herdr tab); anything else a new Herdr tab. Panel splits (splitActiveTerminal) can't be told
// apart, so they make new tabs. In the Cockpit window "Herdr Shell" is the default profile, so a plain "+" does
// this; elsewhere the profiles are in the dropdown.
import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './brand';
import * as path from 'path';
import { agentTitle } from './herdrActions';
import { ManageDeps, pickAgent, startAgent } from './manage';
import type { AgentProfile } from './agentProfiles';
import type { Space } from './model';
import type { HerdrPty } from './builtinTerminal';
import { herdrTabName, shellTabName } from './viewState';
import { errorText } from './herdrClient';
import { sleep } from './format';

/** Must match package.json contributes.terminal.profiles. */
export const SHELL_PROFILE_TITLE = 'Herdr Shell';
const PROFILES: { id: string; kind?: string; pick?: boolean }[] = [
  { id: 'herdr.shell' },
  { id: 'herdr.agent.claude', kind: 'claude' },
  { id: 'herdr.agent.codex', kind: 'codex' },
  { id: 'herdr.agent.kiro', kind: 'kiro' },
  { id: 'herdr.agent.cursor', kind: 'cursor' },
  { id: 'herdr.agent.other', pick: true },
];

export interface ProfileDeps extends ManageDeps {
  /** Which space a new terminal goes to; undefined when Herdr isn't reachable or none was chosen. */
  targetSpace(): Promise<Space | undefined>;
  newPty(target: () => Promise<string>): HerdrPty;
  adopt(paneId: string, spaceId: string, term: vscode.Terminal, pty: HerdrPty, name: string): void;
  /** The pane a tab shows, if it's a Herdr tab. */
  paneOf(term: vscode.Terminal | undefined): { paneId: string; spaceId: string } | undefined;
  startHerdr(): Promise<boolean>;
}

/** How long to wait, once the tab opens, for VS Code to place it (a split gets a new editor group). */
const PLACEMENT_MS = 150;

/** A normal login shell, for when Herdr can't take the terminal. */
function localShell(): vscode.TerminalProfile {
  const shell = process.env.SHELL || '/bin/zsh';
  return new vscode.TerminalProfile({ name: path.basename(shell), shellPath: shell, shellArgs: ['-l'] });
}

export function registerProfiles(deps: ProfileDeps): vscode.Disposable {
  // Say why "+" opened a plain shell, once per session (not on every click).
  let warned = false;
  const fallback = (reason: string): vscode.TerminalProfile => {
    if (!warned) {
      warned = true;
      void vscode.window.showWarningMessage(`${MESSAGE_PREFIX}: ${reason} "+" opens local shells until it's back.`, 'Start Herdr').then(async (pick) => {
        if (!pick) {
          return;
        }
        await deps.startHerdr().catch((e) => deps.log(`start herdr: ${errorText(e)}`));
      });
    }
    return localShell();
  };
  /**
   * The terminal VS Code made for each tab we answered with (onDidOpenTerminal comes before the tab opens). Weak:
   * a tab closed before its pane exists never comes back for its entry.
   */
  const opened = new WeakMap<HerdrPty, vscode.Terminal>();

  const provide = async (p: (typeof PROFILES)[number]): Promise<vscode.TerminalProfile> => {
    // "Other Agent…" lists herdr.agents rows too: a row with variables gives them to the pane.
    let kind = p.kind;
    let profile: AgentProfile | undefined;
    if (p.pick) {
      const what = await pickAgent(deps, 'New agent tab');
      if (!what?.kind) {
        return localShell();
      }
      kind = what.kind;
      profile = what.profile;
    }
    const space = await deps.targetSpace();
    if (!space) return fallback("isn't running, or no space was chosen.");
    // The tab being split, if this turns out to be a split: the active Herdr tab of the same space.
    const parent = deps.paneOf(vscode.window.activeTerminal);
    const splitOf = parent?.spaceId === space.id ? parent.paneId : undefined;
    const groupsBefore = vscode.window.tabGroups.all.length;
    let title = SHELL_PROFILE_TITLE;
    if (profile) {
      title = profile.name;
    } else if (kind) {
      title = agentTitle(kind);
    }
    const env = profile && { env: profile.env };

    const pty: HerdrPty = deps.newPty(async () => {
      await sleep(PLACEMENT_MS);
      const split = !!splitOf && vscode.window.tabGroups.all.length > groupsBefore;
      let paneId: string;
      let name: string;
      try {
        // Same name the sidebar will show for this pane (see paneName()): an agent's title, else the pane's
        // label (a split) or its Herdr tab's (a new tab).
        let agentLabel: string | undefined;
        if (kind) {
          agentLabel = title;
        }
        if (split) {
          const pane = await deps.actions.splitPane({ target_pane_id: splitOf, direction: 'right', cwd: space.cwd, ...env });
          paneId = pane.pane_id;
          name = agentLabel ?? pane.label ?? title;
        } else {
          const { tab, pane } = await deps.actions.createTab({ workspace_id: space.id, cwd: space.cwd, label: agentLabel, ...env });
          paneId = pane.pane_id;
          name = agentLabel ?? shellTabName(tab.label);
        }
      } catch (e) {
        opened.delete(pty);
        deps.log(`profile ${p.id}: ${errorText(e)}`);
        throw new Error(`couldn't create a ${split ? 'split' : 'tab'} in ${space.label}`);
      }
      deps.log(`profile ${p.id}: ${split ? `split ${splitOf} ->` : 'new tab'} ${paneId} in ${space.label}`);
      let term = opened.get(pty);
      for (let i = 0; !term && i < 20; i++) {
        await sleep(50);
        term = opened.get(pty);
      }
      opened.delete(pty);
      if (term) deps.adopt(paneId, space.id, term, pty, herdrTabName(name));
      if (kind) startAgent(deps, paneId, kind, space.label, { profile });
      return paneId;
    });
    // No shell process in the tab, so extensions that type into new terminals (Python Environments'
    // `source .venv/bin/activate`) leave it alone. It opens where "+" (or Split) put it.
    return new vscode.TerminalProfile({ name: title, pty, iconPath: deps.agentIcon(kind) ?? new vscode.ThemeIcon('terminal'), isTransient: true });
  };

  return vscode.Disposable.from(
    ...PROFILES.map((p) => vscode.window.registerTerminalProfileProvider(p.id, { provideTerminalProfile: () => provide(p) })),
    vscode.window.onDidOpenTerminal((term) => {
      const pty = (term.creationOptions as vscode.ExtensionTerminalOptions).pty as HerdrPty | undefined;
      if (pty && !pty.paneId) opened.set(pty, term);
    }),
  );
}
