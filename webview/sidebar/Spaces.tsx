// The Spaces section: "This window" / "Other spaces" (or one list), space cards with their git line, agents and
// a foldable Shells group.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { SpaceView, ViewState } from '../../src/sidebar/viewState';
import { ago } from '../../src/util/format';
import { post, postReorder, postSpaceOrder, useNow, type UiState } from './host';
import { AgentRow, keepFocus, type Reorder, shellState, ShellRow, useDragMove } from './Rows';
import { FoldHeading, Icon, IconButton, menuContext, pressable } from './ui';

type Update = (change: (ui: UiState) => UiState) => void;

const plural = (k: number, one: string) => {
  if (k === 1) {
    return `${k} ${one}`;
  }
  return `${k} ${one}s`;
};

/** Branch · last commit · upstream sync · working-tree state, which doubles as the space's Review button. */
function GitLine({ sp }: { sp: SpaceView }) {
  const now = useNow();
  const g = sp.git;
  if (!g) {
    return null;
  }
  let last = 'No commits yet';
  if (g.lastCommit) {
    last = `Last commit ${ago(now - g.lastCommit.at)} ago: ${g.lastCommit.subject}`;
  }
  let worktree = '';
  let branchIcon = 'git-branch';
  if (sp.worktree) {
    worktree = 'Herdr worktree · ';
    branchIcon = 'repo-forked';
  }
  const branch = (
    <span className="m branch" title={`${worktree}Branch ${g.branch}\n${last}`}>
      <Icon name={branchIcon} />
      <span className="bn">{g.branch || '?'}</span>
      {g.lastCommit && <span className="age">{ago(now - g.lastCommit.at)}</span>}
    </span>
  );
  let sync: ReactNode = null;
  if (g.detached) {
    sync = null;
  } else if (!g.upstream) {
    sync = (
      <span className="m muted" title="This branch doesn't track a remote branch (never pushed, or pushed without -u)">
        <Icon name="cloud-upload" />
        no upstream
      </span>
    );
  } else if (g.ahead || g.behind) {
    const parts: string[] = [];
    if (g.ahead) {
      parts.push(`${plural(g.ahead, 'commit')} to push`);
    }
    if (g.behind) {
      parts.push(`${plural(g.behind, 'commit')} to pull`);
    }
    sync = (
      <span className="m sync" title={`${parts.join(', ')} (${g.upstream})`}>
        {!!g.ahead && <Icon name="arrow-up" />}
        {!!g.ahead && g.ahead}
        {!!g.behind && <Icon name="arrow-down" />}
        {!!g.behind && g.behind}
      </span>
    );
  } else {
    sync = (
      <span className="m muted" title={`Up to date with ${g.upstream}`}>
        <Icon name="check" />
        synced
      </span>
    );
  }
  if (!g.changes) {
    return (
      <>
        {branch}
        {sync}
        <span className="m clean" title="No uncommitted changes">
          <Icon name="pass" />
          clean
        </span>
      </>
    );
  }
  // A worktree space reviews its whole branch (review.ts); any other space its uncommitted changes.
  let reviewTitle = "Review this space's uncommitted changes (HEAD ↔ working tree)";
  if (sp.worktree) {
    reviewTitle = "Review this worktree's branch: its commits and uncommitted changes (merge base ↔ working tree)";
  }
  return (
    <>
      {branch}
      {sync}
      <button
        className="m changes"
        title={reviewTitle}
        onClick={(e) => {
          e.stopPropagation();
          post('review', { spaceId: sp.id });
        }}
      >
        {!!g.conflicts && (
          <span className="g-conflict">
            <Icon name="warning" />
            {plural(g.conflicts, 'conflict')}
          </span>
        )}
        {!!g.staged && (
          <span className="g-staged">
            <Icon name="circle-filled" />
            {g.staged} staged
          </span>
        )}
        {!!g.modified && (
          <span className="g-modified">
            <Icon name="circle-filled" />
            {g.modified} modified
          </span>
        )}
        {!!g.untracked && (
          <span className="g-new">
            <Icon name="add" />
            {g.untracked} new
          </span>
        )}
        <span className="review">
          <Icon name="diff" />
          Review
        </span>
      </button>
    </>
  );
}

/** Moving items within one list (`ids` in the order they show); `save` gets the list's new order. */
function listReorder(group: string, ids: string[], save: (ids: string[]) => void): Reorder {
  return {
    group,
    move(id, target, after) {
      const rest = ids.filter((x) => x !== id);
      let at = rest.indexOf(target);
      if (after) {
        at++;
      }
      rest.splice(at, 0, id);
      save(rest);
    },
    step(id, by) {
      const from = ids.indexOf(id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= ids.length) {
        return;
      }
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, id);
      save(next);
    },
  };
}

/**
 * Moving rows within one of a space's lists (`agents` or `shells`); what's saved is the whole space's order, the
 * other list as it shows. Only the sidebar's order: Herdr's tabs stay where they are.
 */
function reorderOf(sp: SpaceView, list: 'agents' | 'shells'): Reorder | undefined {
  const rows = sp[list];
  if (rows.length < 2) {
    return undefined;
  }
  return listReorder(
    `${sp.id}/${list}`,
    rows.map((p) => p.id),
    (ids) => {
      let order = [...ids, ...sp.shells.map((p) => p.id)];
      if (list === 'shells') {
        order = [...sp.agents.map((p) => p.id), ...ids];
      }
      postReorder(sp.id, order);
    },
  );
}

/** Moving space cards within one section (This window, Other windows, Other spaces, or the one list). Sidebar only. */
function spacesReorder(section: string, spaces: SpaceView[]): Reorder | undefined {
  if (spaces.length < 2) {
    return undefined;
  }
  return listReorder(
    `spaces/${section}`,
    spaces.map((sp) => sp.id),
    postSpaceOrder,
  );
}

function ShellGroup({ sp, ui, update }: { sp: SpaceView; ui: UiState; update: Update }) {
  const now = useNow();
  if (!sp.shells.length) {
    return null;
  }
  const open = ui.shellsOpen[sp.id] ?? sp.shellsDefaultOpen;
  const shellOrder = reorderOf(sp, 'shells');
  const states = sp.shells.map((p) => shellState(p, now));
  const running = states.filter((s) => s === 'live' || s === 'running').length;
  const failed = states.filter((s) => s === 'failed').length;
  let groupCls = 'group';
  if (!open) {
    groupCls += ' closed';
  }
  return (
    <>
      <FoldHeading className={groupCls} open={open} onToggle={() => update((u) => ({ ...u, shellsOpen: { ...u.shellsOpen, [sp.id]: !open } }))}>
        Shells · {sp.shells.length}
        <span className="sum">
          {running > 0 && <span className="sh-running">{running} running</span>}
          {failed > 0 && <span className="sh-failed">{plural(failed, 'error')}</span>}
        </span>
      </FoldHeading>
      {open && (
        <div className="shells">
          {sp.shells.map((p) => (
            <ShellRow key={p.id} p={p} reorder={shellOrder} expanded={!!ui.expanded[p.id]} onExpand={(o) => update((u) => ({ ...u, expanded: { ...u.expanded, [p.id]: o } }))} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Where the space lives: its folder (shortened, the full path on hover), and for a worktree, whose checkout it is
 * (left out under its repository's card, herdr.groupWorktrees: where it's drawn says so).
 */
function FolderLine({ sp }: { sp: SpaceView }) {
  const f = sp.folder;
  if (!f) {
    return null;
  }
  let title = sp.path ?? f.text;
  let icon = 'folder';
  if (f.worktreeOf) {
    title = `A worktree of ${f.worktreeOf}: its own checkout and branch\n${title}`;
    icon = 'repo-forked';
  }
  if (f.worktreeOf && sp.under) {
    return (
      <div className="space-folder" title={title}>
        <Icon name={icon} />
        <span className="folder-path">{f.text}</span>
      </div>
    );
  }
  if (f.worktreeOf) {
    // Two lines: its whole folder (shortened, Herdr's worktree folders all look alike), then whose checkout it is.
    return (
      <div className="space-folder worktree" title={title}>
        <div className="folder-row">
          <Icon name="folder" />
          <span className="folder-path">{f.text}</span>
        </div>
        <div className="folder-row">
          <Icon name={icon} />
          <span className="worktree-of">Worktree of {f.worktreeOf}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="space-folder" title={title}>
      <Icon name={icon} />
      <span className="folder-path">{f.text}</span>
    </div>
  );
}

interface CardProps {
  sp: SpaceView;
  ui: UiState;
  update: Update;
  showShells: boolean;
  worktrees: boolean;
  /** The card can be dragged to another place in its section. */
  reorder?: Reorder;
  /** You dragged spaces into an order of your own (the menu offers Reset Space Order). */
  spacesReordered: boolean;
}

function SpaceCard({ sp, ui, update, showShells, worktrees, reorder, spacesReordered }: CardProps) {
  const drag = useDragMove(sp.id, reorder);
  // New worktree, when the driver makes worktree spaces.
  const repo = !!sp.git && worktrees;
  const open = ui.open[sp.id] ?? sp.defaultOpen;
  const setOpen = (o: boolean) => update((u) => ({ ...u, open: { ...u.open, [sp.id]: o } }));
  let cls = `space st-${sp.status ?? 'none'}${drag.cls}`;
  if (open) {
    cls += ' open';
  }
  if (sp.focused) {
    cls += ' herdr-focused';
  }
  let chev = 'chev';
  if (!open) {
    chev += ' closed';
  }
  const onKey = (e: KeyboardEvent) => {
    if (reorder && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Before App's Up/Down navigation sees it.
      e.preventDefault();
      e.stopPropagation();
      let by = 1;
      if (e.key === 'ArrowUp') {
        by = -1;
      }
      reorder.step(sp.id, by);
      keepFocus(() => document.querySelector<HTMLElement>(`[data-space="${CSS.escape(sp.id)}"] > .space-head`) ?? undefined);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setOpen(e.key === 'ArrowRight');
    }
  };
  let title = sp.label;
  if (sp.path) {
    title += `\n${sp.path}`;
  }
  title += '\nClick to fold or unfold. Click an agent or shell to open its tab.';
  if (!sp.here) {
    title += ' Open opens the whole space.';
  }
  if (reorder) {
    title += ' Drag it, or Alt+Up/Down, to move it.';
  }
  let empty = 'No agents in this space';
  if (showShells) {
    empty = 'No agents or shells in this space';
  }
  let section = 'space';
  if (sp.mounted) {
    section = 'space-mounted';
  }
  const agentOrder = reorderOf(sp, 'agents');
  let openTitle = "Open this space: its folder and its agents' and shells' tabs (in its own window or this one)";
  if (sp.elsewhere) {
    openTitle = 'Bring forward the window that has this space open';
  }
  const openSpace = () => {
    setOpen(true);
    post('switch', { spaceId: sp.id });
  };
  return (
    <section className={cls} data-space={sp.id} {...drag.target}>
      <div
        className="space-head"
        title={title}
        data-vscode-context={menuContext({ webviewSection: section, spaceId: sp.id, spaceRepo: repo, spaceReordered: sp.reordered, spacesReordered })}
        {...drag.source}
        {...pressable(() => setOpen(!open), { expanded: open, onKey })}
      >
        <span className={chev}>
          <Icon name="chevron-down" />
        </span>
        <span className="space-name">{sp.label}</span>
        <span className="dots">
          {sp.agents.map((a) => (
            <span key={a.id} className={`dot st-${a.status ?? 'unknown'}`} title={`${a.name}: ${a.status}`} />
          ))}
        </span>
        <IconButton icon="add" className="card-btn" title={`New tab in ${sp.label}: a shell or an agent`} onClick={() => post('newTab', { spaceId: sp.id })} />
        {repo && (
          <IconButton
            icon="git-branch-create"
            className="card-btn"
            title={`Worktrees of ${sp.label}: start a new one (a branch and checkout for one piece of work, like a ticket), go to or open one, or delete one`}
            onClick={() => post('worktreeMenu', { spaceId: sp.id })}
          />
        )}
        {!sp.here && (
          <button
            className="open-btn"
            title={openTitle}
            onClick={(e) => {
              e.stopPropagation();
              openSpace();
            }}
          >
            Open
          </button>
        )}
      </div>
      <FolderLine sp={sp} />
      <div className="space-meta">
        <GitLine sp={sp} />
        {sp.tokens.map((t) => (
          <span className="m" key={t}>
            {t}
          </span>
        ))}
      </div>
      {open && (
        <div className="space-body">
          {sp.agents.map((a) => (
            <AgentRow key={a.id} p={a} reorder={agentOrder} expanded={!!ui.expanded[a.id]} onExpand={(o) => update((u) => ({ ...u, expanded: { ...u.expanded, [a.id]: o } }))} />
          ))}
          <ShellGroup sp={sp} ui={ui} update={update} />
          {!sp.agents.length && !sp.shells.length && <div className="empty-note">{empty}</div>}
        </div>
      )}
    </section>
  );
}

function NoSpaceCard({ name, canAdd }: { name: string; canAdd: boolean }) {
  return (
    <div className="no-space">
      <div className="no-space-title">
        No Herdr space for <b>{name}</b>
      </div>
      <div className="no-space-sub">A space shows here when its folder is open in this window.</div>
      <div className="no-space-btns">
        <button className="btn" onClick={() => post('newSpaceHere')}>
          Create space here
        </button>
        {canAdd && (
          <button className="btn secondary" onClick={() => post('addSpaceHere')}>
            Add a space…
          </button>
        )}
      </div>
    </div>
  );
}

/** The pane has a terminal tab in this window (its row says so). */
function hasTab(state: ViewState, paneId: string): boolean {
  return state.spaces.some((sp) => [...sp.agents, ...sp.shells].some((p) => p.id === paneId && p.attached));
}

/**
 * When you move to another Herdr tab, unfold what hides its row (its group, its card, the Shells group) and scroll it
 * into view. Only on the move: fold it again afterwards and it stays folded.
 */
function useActiveRow(state: ViewState, update: Update) {
  const row = state.activeRow;
  // The last tab moved to: going to a file and back to the same tab isn't a move, so a card you folded stays folded.
  const last = useRef<string | undefined>(undefined);
  // That tab closed: opening the pane again is a move again.
  // Only with spaces to look in: while Herdr is away there are none, and the tab you're still in isn't closed.
  if (!row && last.current && state.spaces.length && !hasTab(state, last.current)) {
    last.current = undefined;
  }
  useEffect(() => {
    if (!row || row.id === last.current) {
      return;
    }
    last.current = row.id;
    update((u) => {
      const next: UiState = { ...u, open: { ...u.open, [row.spaceId]: true } };
      if (row.kind === 'shell') {
        next.shellsOpen = { ...u.shellsOpen, [row.spaceId]: true };
      }
      if (row.group === 'elsewhere') {
        next.elsewhereOpen = true;
      } else if (row.group === 'others') {
        next.othersOpen = true;
      }
      return next;
    });
    const t = setTimeout(() => {
      document.querySelector(`[data-space="${CSS.escape(row.spaceId)}"] [data-pane="${CSS.escape(row.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }, 50);
    return () => clearTimeout(t);
  }, [row?.id]);
}

export function SpacesSection({ state, ui, update }: { state: ViewState; ui: UiState; update: Update }) {
  useActiveRow(state, update);
  const cards = (section: string, spaces: SpaceView[]) => {
    const reorder = spacesReorder(section, spaces);
    const card = (sp: SpaceView) => (
      <SpaceCard
        key={sp.id}
        sp={sp}
        ui={ui}
        update={update}
        showShells={state.showShells}
        worktrees={state.worktrees}
        reorder={reorder}
        spacesReordered={state.spacesReordered}
      />
    );
    // herdr.groupWorktrees: a repository's worktree spaces come right after it (viewState.ts groupUnderRepos), drawn
    // indented under its card along a guide line.
    const out: ReactNode[] = [];
    for (const sp of spaces) {
      if (sp.under) {
        continue;
      }
      out.push(card(sp));
      const kids = spaces.filter((c) => c.under === sp.id);
      if (kids.length) {
        out.push(
          <div key={`${sp.id}/worktrees`} className="space-children">
            {kids.map(card)}
          </div>,
        );
      }
    }
    return out;
  };
  const { layout } = state;
  let body: ReactNode;
  if (layout.split) {
    const here = state.spaces.filter((sp) => sp.here);
    const elsewhere = state.spaces.filter((sp) => !sp.here && sp.elsewhere);
    const others = state.spaces.filter((sp) => !sp.here && !sp.elsewhere);
    const elsewhereOpen = ui.elsewhereOpen ?? layout.othersOpenByDefault;
    const othersOpen = ui.othersOpen ?? layout.othersOpenByDefault;
    body = (
      <>
        {(here.length > 0 || layout.noSpaceHere) && <div className="sub-label">This window</div>}
        {layout.noSpaceHere && <NoSpaceCard name={layout.noSpaceHere.name} canAdd={layout.noSpaceHere.canAdd} />}
        {cards('here', here)}
        {elsewhere.length > 0 && (
          <FoldHeading
            className="sub-label others-label"
            open={elsewhereOpen}
            title="Spaces open in another window: Open brings that window forward"
            onToggle={() => update((u) => ({ ...u, elsewhereOpen: !elsewhereOpen }))}
          >
            Other windows <span className="count">{elsewhere.length}</span>
          </FoldHeading>
        )}
        {elsewhereOpen && cards('elsewhere', elsewhere)}
        {others.length > 0 && (
          <FoldHeading
            className="sub-label others-label"
            open={othersOpen}
            title="Spaces in Herdr that no window has open yet"
            onToggle={() => update((u) => ({ ...u, othersOpen: !othersOpen }))}
          >
            Other spaces <span className="count">{others.length}</span>
          </FoldHeading>
        )}
        {othersOpen && cards('others', others)}
      </>
    );
  } else if (state.spaces.length) {
    body = cards('all', state.spaces);
  } else {
    body = (
      <div className="splash">
        <div className="big">
          <Icon name="layers" />
        </div>
        <h2>No spaces yet</h2>
        <p>A space is a folder with its agents and shells.</p>
        <div className="btns">
          <button className="btn" onClick={() => post('newSpace')}>
            New space
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="section-label">
        Spaces
        <button className="icon-btn label-btn" title="New space: in a folder, or on a git worktree (new, or one that has no space)" aria-label="New space" onClick={() => post('newSpace')}>
          <Icon name="add" />
        </button>
      </div>
      <div className="spaces">{body}</div>
    </>
  );
}
