// The driver layer's vscode side: building this window's driver, its backend (backend.ts) and its terminal tabs
// (paneTab.ts). Herdr is the only driver on this branch (the native one lives on the native-driver branch). A new
// driver = a Backend, a TabFactory, and a branch here.
import type { Backend } from './backend';
import { BuiltinDeps, HerdrPty } from './herdr/builtinTerminal';
import { HerdrBackend } from './herdr/herdrBackend';
import type { HerdrClient } from './herdr/herdrClient';
import type { TabFactory } from './paneTab';

export interface Driver {
  backend: Backend;
  newTab: TabFactory;
}

/** Herdr: the server over its socket, tabs drawn from its stream. */
export function herdrDriver(client: HerdrClient, tabDeps: Omit<BuiltinDeps, 'onEnded'>): Driver {
  return {
    backend: new HerdrBackend(client),
    newTab: (target, opts, onEnded) => new HerdrPty(target, { ...tabDeps, onEnded }, opts),
  };
}
