// Which window a space (or one of its panes) opens in, as plain decisions: extension.ts gathers the facts
// (folders, other windows' records, settings) and carries the decision out. No vscode imports (test/placementTest.ts).

/** Where a space this window doesn't have goes: its own window, or added to this workspace. */
export type Placement = 'window' | 'workspace';

/** herdr.windowMode: each space in a window of its own, or all spaces as folders of one workspace. */
export type WindowMode = 'folder' | 'workspace';

export interface PlaceFacts {
  /** An explicit choice (right-click Open in Its Own Window / Add to This Window). */
  how?: Placement;
  /** A pane of the space was clicked (else the space itself). */
  pane: boolean;
  mode: WindowMode;
  /** This window is the space's own: its only folder is the space's. */
  ownWindow: boolean;
  /** The space is open in this window (its folder is one of ours, or its tabs are here). */
  openHere: boolean;
  /** The space's current folder is mounted here. */
  mounted: boolean;
  /** Another window of this editor has the space. */
  otherWindow: boolean;
  /** This window has a folder. */
  hasFolders: boolean;
  /** "Always…" chosen for this window. */
  remembered?: Placement;
}

/**
 * - here: switch this window to the space
 * - add: mount it next to this window's folders
 * - stay: its tabs are here already; open the pane, mount nothing
 * - window: open it in its own window (the one that has it, else a new one)
 * - askHub: workspace mode outside the Cockpit window: offer the Cockpit window (or use this one)
 * - ask: folder mode: ask own window or this one (unless remembered)
 */
export type PlaceDecision = 'here' | 'add' | 'stay' | 'window' | 'askHub' | 'ask';

export function decidePlacement(f: PlaceFacts): PlaceDecision {
  if (f.how === 'window') {
    if (f.ownWindow) {
      return 'here';
    }
    return 'window';
  }
  if (f.how === 'workspace') {
    return 'add';
  }
  // 1. The space is open in this window: a pane opens here, next to the other spaces (nothing is swapped out).
  if (f.openHere) {
    if (f.pane && !f.mounted) {
      return 'stay'; // its tabs are here but its shell moved to another folder: don't mount that one
    }
    if (f.pane || f.mode === 'folder') {
      return 'add';
    }
    return 'here'; // workspace mode, the space itself clicked: switch to it as before
  }
  // 2. Another window has it: open it there.
  if (f.otherWindow) {
    return 'window';
  }
  if (f.mode === 'workspace') {
    return 'askHub';
  }
  // 3. Folder mode. A window without a folder becomes the space's window; otherwise ask (or what was remembered).
  if (!f.hasFolders) {
    return 'window';
  }
  if (f.remembered === 'workspace') {
    return 'add';
  }
  if (f.remembered === 'window') {
    return 'window';
  }
  return 'ask';
}

/**
 * Follow mode: should this window switch to the space Herdr just focused? Not when another window has it; and in
 * folder mode a window of its own only follows into its own space (the Cockpit window follows everywhere).
 */
export function followsInto(f: { otherWindow: boolean; mode: WindowMode; hub: boolean; mounted: boolean }): boolean {
  if (f.otherWindow) {
    return false;
  }
  if (f.mode === 'folder' && !f.hub && !f.mounted) {
    return false;
  }
  return true;
}
