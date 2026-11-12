// Which of our terminals each editor tab shows. VS Code's tab API doesn't say, so a tab we've already tied to a
// terminal (seen opening, or active while its terminal was) is matched for sure; the rest by name, tabs with the
// same name in the order their terminals opened. No vscode imports (test/tabMatchTest.ts).

/** An editor-area terminal tab, in tab-bar order (group by group, left to right). */
export interface TabRef<T> {
  tab: T;
  label: string;
  column: number;
  index: number;
}

/** One of our live terminals, in the order they opened. */
export interface NamedPane {
  paneId: string;
  name: string;
}

/** The tabs that show one of `panes`, in tab-bar order, each with its pane. */
export function matchTabs<T>(tabs: TabRef<T>[], panes: NamedPane[], boundTo: (tab: T) => string | undefined): (TabRef<T> & { paneId: string })[] {
  const ours = new Set(panes.map((p) => p.paneId));
  const taken = new Set<string>();
  const byTab = new Map<TabRef<T>, string>();
  for (const t of tabs) {
    const paneId = boundTo(t.tab);
    if (paneId && ours.has(paneId) && !taken.has(paneId)) {
      byTab.set(t, paneId);
      taken.add(paneId);
    }
  }
  for (const t of tabs) {
    if (byTab.has(t)) {
      continue;
    }
    const p = panes.find((x) => !taken.has(x.paneId) && x.name === t.label);
    if (p) {
      byTab.set(t, p.paneId);
      taken.add(p.paneId);
    }
  }
  const matched: (TabRef<T> & { paneId: string })[] = [];
  for (const t of tabs) {
    const paneId = byTab.get(t);
    if (paneId) {
      matched.push({ ...t, paneId });
    }
  }
  return matched;
}

/**
 * The tab to move next so `matched` (one editor group, in tab-bar order) ends up sorted by `rank`, keeping the
 * slots our tabs already take: the first slot holding the wrong tab, and the tab that belongs there.
 */
export function nextMove<M extends { paneId: string; index: number }>(matched: M[], rank: (paneId: string) => number): { tab: M; to: number } | undefined {
  const slots = matched.map((t) => t.index);
  const wanted = [...matched].sort((a, b) => rank(a.paneId) - rank(b.paneId));
  const k = wanted.findIndex((t, i) => t.index !== slots[i]);
  if (k < 0) {
    return undefined;
  }
  return { tab: wanted[k], to: slots[k] };
}
