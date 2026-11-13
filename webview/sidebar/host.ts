// The webview's side of src/panel.ts: actions go back as { type: 'cmd', command, spaceId?, paneId? }, and
// what's folded or expanded is kept in VS Code's webview state, so it survives the view being hidden.
import { useCallback, useState, useSyncExternalStore } from 'react';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Run a Herdr Cockpit action (a key of PANEL_COMMANDS in src/extension.ts) for a space or pane. */
export function post(command: string, target: { spaceId?: string; paneId?: string; account?: string } = {}) {
  vscode.postMessage({ type: 'cmd', command, spaceId: target.spaceId, paneId: target.paneId, account: target.account });
}

export function ready() {
  vscode.postMessage({ type: 'ready' });
}

/** What you folded or expanded. Unset entries follow the defaults the extension sends (SpaceView.defaultOpen, ...). */
export interface UiState {
  open: Record<string, boolean>;
  shellsOpen: Record<string, boolean>;
  expanded: Record<string, boolean>;
  usageOpen?: boolean;
  othersOpen?: boolean;
}

function loadUi(): UiState {
  const saved = (vscode.getState() ?? {}) as Partial<UiState>;
  return {
    open: saved.open ?? {},
    shellsOpen: saved.shellsOpen ?? {},
    expanded: saved.expanded ?? {},
    usageOpen: saved.usageOpen,
    othersOpen: saved.othersOpen,
  };
}

/** The UI state and a function to change it (saved right away). */
export function useUiState(): [UiState, (change: (ui: UiState) => UiState) => void] {
  const [ui, setUi] = useState(loadUi);
  const update = useCallback((change: (ui: UiState) => UiState) => {
    setUi((prev) => {
      const next = change(prev);
      vscode.setState(next);
      return next;
    });
  }, []);
  return [ui, update];
}

// ---------- a clock for relative times, ticking once a second only while the sidebar is visible ----------
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function sync() {
  const want = listeners.size > 0 && document.visibilityState === 'visible';
  if (want && !timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) {
        l();
      }
    }, 1000);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
document.addEventListener('visibilitychange', sync);

function subscribe(listener: () => void) {
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    sync();
  };
}

/** The current time, updated every second while the sidebar is visible. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
