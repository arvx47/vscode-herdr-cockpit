// The Spaces section: "This window" / "Other spaces" (or one list), space cards with their git line, agents and
// a foldable Shells group.
import type { KeyboardEvent, ReactNode } from 'react';
import type { SpaceView, ViewState } from '../../src/viewState';
import { ago } from '../../src/format';
import { post, useNow, type UiState } from './host';
import { AgentRow, shellState, ShellRow } from './Rows';
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

function ShellGroup({ sp, ui, update }: { sp: SpaceView; ui: UiState; update: Update }) {
  const now = useNow();
  if (!sp.shells.length) {
    return null;
  }
  const open = ui.shellsOpen[sp.id] ?? sp.shellsDefaultOpen;
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
            <ShellRow key={p.id} p={p} expanded={!!ui.expanded[p.id]} onExpand={(o) => update((u) => ({ ...u, expanded: { ...u.expanded, [p.id]: o } }))} />
          ))}
        </div>
      )}
    </>
  );
}

/** Where the space lives: its folder (shortened, the full path on hover), and for a worktree, whose checkout it is. */
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
  return (
    <div className="space-folder" title={title}>
      <Icon name={icon} />
      {f.worktreeOf && <span className="worktree-of">{f.worktreeOf} worktree ·</span>}
      <span className="folder-path">{f.text}</span>
    </div>
  );
}

function SpaceCard({ sp, ui, update, showShells }: { sp: SpaceView; ui: UiState; update: Update; showShells: boolean }) {
  const open = ui.open[sp.id] ?? sp.defaultOpen;
  const setOpen = (o: boolean) => update((u) => ({ ...u, open: { ...u.open, [sp.id]: o } }));
  let cls = `space st-${sp.status ?? 'none'}`;
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
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
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
  let empty = 'No agents in this space';
  if (showShells) {
    empty = 'No agents or shells in this space';
  }
  let section = 'space';
  if (sp.mounted) {
    section = 'space-mounted';
  }
  const openSpace = () => {
    setOpen(true);
    post('switch', { spaceId: sp.id });
  };
  return (
    <section className={cls} data-space={sp.id}>
      <div
        className="space-head"
        title={title}
        data-vscode-context={menuContext({ webviewSection: section, spaceId: sp.id, spaceRepo: !!sp.git })}
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
        {!!sp.git && (
          <IconButton
            icon="git-branch-create"
            className="worktree-btn"
            title={`New worktree of ${sp.label}: a new branch and checkout for one piece of work (a ticket), in a space of its own`}
            onClick={() => post('newWorktree', { spaceId: sp.id })}
          />
        )}
        {!sp.here && (
          <button
            className="open-btn"
            title="Open this space: its folder and its agents' and shells' tabs (in its own window or this one)"
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
            <AgentRow key={a.id} p={a} expanded={!!ui.expanded[a.id]} onExpand={(o) => update((u) => ({ ...u, expanded: { ...u.expanded, [a.id]: o } }))} />
          ))}
          <ShellGroup sp={sp} ui={ui} update={update} />
          {!sp.agents.length && !sp.shells.length && <div className="empty-note">{empty}</div>}
          <button
            className="add-row"
            data-nav=""
            title={`New tab in ${sp.label}: a shell or an agent`}
            onClick={(e) => {
              e.stopPropagation();
              post('newTab', { spaceId: sp.id });
            }}
          >
            <Icon name="add" />
            New tab
          </button>
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

export function SpacesSection({ state, ui, update }: { state: ViewState; ui: UiState; update: Update }) {
  const card = (sp: SpaceView) => <SpaceCard key={sp.id} sp={sp} ui={ui} update={update} showShells={state.showShells} />;
  const { layout } = state;
  let body: ReactNode;
  if (layout.split) {
    const here = state.spaces.filter((sp) => sp.here);
    const others = state.spaces.filter((sp) => !sp.here);
    const othersOpen = ui.othersOpen ?? layout.othersOpenByDefault;
    body = (
      <>
        <div className="sub-label">This window</div>
        {layout.noSpaceHere && <NoSpaceCard name={layout.noSpaceHere.name} canAdd={layout.noSpaceHere.canAdd} />}
        {here.map(card)}
        {others.length > 0 && (
          <FoldHeading
            className="sub-label others-label"
            open={othersOpen}
            title="Spaces open in another window or not open yet"
            onToggle={() => update((u) => ({ ...u, othersOpen: !othersOpen }))}
          >
            Other spaces <span className="count">{others.length}</span>
          </FoldHeading>
        )}
        {othersOpen && others.map(card)}
      </>
    );
  } else if (state.spaces.length) {
    body = state.spaces.map(card);
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
        <button className="icon-btn label-btn" title="New space: a folder or a new git worktree" aria-label="New space" onClick={() => post('newSpace')}>
          <Icon name="add" />
        </button>
      </div>
      <div className="spaces">{body}</div>
    </>
  );
}
