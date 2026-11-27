// Agent and shell rows: two lines (name + status, then one line of context); the chevron reveals the rest.
import { useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import type { PaneView } from '../../src/sidebar/viewState';
import { post, useNow } from './host';
import { AgentLogo, Icon, IconButton, menuContext, pressable, Since } from './ui';

const STATUS_LABEL: Record<string, string> = { blocked: 'Blocked', done: 'Done', working: 'Working', idle: 'Idle', unknown: 'Unknown' };
/** The pill's icon for the states that need you, the same as the counters': the state reads without its color. */
const NEEDS_ICON: Record<string, string> = { blocked: 'warning', done: 'pass-filled' };
/** An agent that turned blocked or done this recently flashes its frame, so the change catches the eye. */
const FRESH_MS = 8000;
/** A shell counts as showing live output this long after its output last changed. */
const LIVE_MS = 12000;

export type ShellState = 'live' | 'running' | 'prompt' | 'failed' | 'unknown';

/**
 * Moving a row or a space with the keyboard re-inserts it (React moves the focused node when it goes down), and the
 * browser drops its focus: for a second, while the host sends the new order, what `find` returns takes it back.
 */
export function keepFocus(find: () => HTMLElement | undefined) {
  const until = Date.now() + 1000;
  const check = () => {
    const el = find();
    if (el && document.activeElement !== el && (document.activeElement === document.body || document.activeElement === null)) {
      el.focus();
    }
    if (Date.now() < until) {
      setTimeout(check, 50);
    }
  };
  setTimeout(check, 0);
}

export function shellState(p: PaneView, now: number): ShellState {
  const sh = p.shell;
  if (!sh) {
    return 'unknown';
  }
  if (sh.state === 'running') {
    if (sh.changedAt && now - sh.changedAt < LIVE_MS) {
      return 'live';
    }
    return 'running';
  }
  if (sh.state === 'prompt') {
    if (sh.failed) {
      return 'failed';
    }
    return 'prompt';
  }
  return 'unknown';
}

/**
 * Dragging an item within its list (a space's agents or its shells, or one section's spaces). `group` names the
 * list: an item only takes drops from its own. `move` puts one before or after another; `step` moves it one place
 * (Alt+Up/Down).
 */
export interface Reorder {
  group: string;
  move(id: string, target: string, after: boolean): void;
  step(id: string, by: number): void;
}

interface RowProps {
  p: PaneView;
  expanded: boolean;
  onExpand: (open: boolean) => void;
  /** In the Needs you list: always expanded, with its space's name. */
  attention?: boolean;
  /** The row can be dragged to another place in its list. */
  reorder?: Reorder;
}

/** What's being dragged (a row or a space card); one drag at a time, so the module keeps it rather than every list. */
let dragging: { id: string; group: string } | undefined;

/**
 * Drag and drop within one list (`reorder.group`): where a drop would land (a line above or below the item) and
 * the handlers. `source` goes on what you grab, `target` on what takes the drop; for a row they're the same element.
 * Drops from another list are left alone, so a row dragged over a space card (or the other way) does nothing.
 */
export function useDragMove(id: string, reorder: Reorder | undefined) {
  const [drop, setDrop] = useState<'before' | 'after'>();
  const [dragged, setDragged] = useState(false);
  if (!reorder) {
    return { cls: '', source: {}, target: {} };
  }
  const accepts = () => dragging?.group === reorder.group && dragging.id !== id;
  const source = {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      // A row inside a space card: the card's own drag doesn't start too.
      e.stopPropagation();
      dragging = { id, group: reorder.group };
      e.dataTransfer.setData('application/x-herdr-move', id);
      e.dataTransfer.effectAllowed = 'move';
      setDragged(true);
    },
    onDragEnd: () => {
      dragging = undefined;
      setDragged(false);
    },
  };
  const target = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!accepts()) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const box = e.currentTarget.getBoundingClientRect();
      if (e.clientY > box.top + box.height / 2) {
        setDrop('after');
      } else {
        setDrop('before');
      }
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      // Moving onto one of its own children isn't leaving it.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDrop(undefined);
      }
    },
    onDrop: (e: DragEvent) => {
      const from = dragging;
      setDrop(undefined);
      if (!from || !accepts()) {
        return;
      }
      e.preventDefault();
      reorder.move(from.id, id, drop === 'after');
    },
  };
  let cls = '';
  if (drop) {
    cls += ` drop-${drop}`;
  }
  if (dragged) {
    cls += ' dragging';
  }
  return { cls, source, target };
}

/**
 * What every row shares: the frame, click to attach, the right-click menu, keyboard expand/collapse. The whole row
 * takes a mouse click; for the keyboard and screen readers the button is the name (`line1` gets it), so the row's
 * own buttons (Review, the chevron) sit beside it rather than inside another button. `label` is what a screen
 * reader says for it: the name and its status.
 */
function RowFrame(props: RowProps & { className: string; label: string; avatar: ReactNode; line1: (name: ReactNode) => ReactNode; body: ReactNode; side: ReactNode }) {
  const { p } = props;
  const drag = useDragMove(p.id, props.reorder);
  let cls = `row ${props.className}${drag.cls}`;
  if (p.focused) {
    cls += ' herdr-focused';
  }
  if (p.active) {
    cls += ` active-${p.active}`;
  }
  if (props.expanded) {
    cls += ' open';
  }
  const open = () => post('attach', { spaceId: p.spaceId, paneId: p.id });
  let hint = 'Click to open it in a terminal tab';
  if (p.attached) {
    hint = 'Click to show its terminal tab';
  }
  if (props.reorder) {
    hint += '. Drag it, or Alt+Up/Down, to move it';
  }
  const onKey = (e: KeyboardEvent) => {
    if (props.reorder && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Before App's Up/Down navigation sees it.
      e.preventDefault();
      e.stopPropagation();
      let by = 1;
      if (e.key === 'ArrowUp') {
        by = -1;
      }
      props.reorder.step(p.id, by);
      // The row in its space, not its copy in Needs you (that list has no reordering).
      keepFocus(
        () =>
          [...document.querySelectorAll<HTMLElement>(`[data-pane="${CSS.escape(p.id)}"]`)]
            .find((r) => !r.closest('.attention'))
            ?.querySelector<HTMLElement>('.row-hit') ?? undefined,
      );
    } else if (!props.attention && p.more && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      props.onExpand(e.key === 'ArrowRight');
    }
  };
  return (
    <div
      className={cls}
      data-pane={p.id}
      title={`${p.name}\n${hint}`}
      data-vscode-context={menuContext({ webviewSection: p.kind, spaceId: p.spaceId, paneId: p.id, spaceHere: p.spaceMounted })}
      onClick={open}
      {...drag.source}
      {...drag.target}
    >
      {props.avatar}
      <div className="main">
        {props.line1(
          <span className="name row-hit" aria-label={props.label} {...pressable(open, { onKey })}>
            {p.name}
          </span>,
        )}
        {props.attention && <div className="where">{p.spaceLabel}</div>}
        {props.body}
      </div>
      <div className="side">{props.side}</div>
    </div>
  );
}

function Expander({ p, open, onExpand }: { p: PaneView; open: boolean; onExpand: (open: boolean) => void }) {
  // Nothing more to show: keep its place so the row's other buttons line up with the rows around it.
  if (!p.more) {
    return <span className="expander" aria-hidden="true" />;
  }
  let icon = 'chevron-down';
  let title = 'Show details';
  if (open) {
    icon = 'chevron-up';
    title = 'Hide details';
  }
  return <IconButton className="expander" icon={icon} title={title} label={`${title}: ${p.name}`} expanded={open} onClick={() => onExpand(!open)} />;
}

/** Expanded-only extras: chips, then the folder when it isn't the space's. */
function Extras({ p }: { p: PaneView }) {
  const hasChips = !!p.tab || p.chips.length > 0;
  return (
    <>
      {hasChips && (
        <div className="chips">
          {p.tab && (
            <span className="chip">
              <Icon name="window" />
              {p.tab}
            </span>
          )}
          {p.chips.map((c) => (
            <span className="chip" key={c}>
              {c}
            </span>
          ))}
        </div>
      )}
      {p.cwd && (
        <div className="cwd" title={p.cwd}>
          <Icon name="folder" />
          {p.cwd}
        </div>
      )}
    </>
  );
}

function Lines({ lines }: { lines: string[] }) {
  if (!lines.length) {
    return null;
  }
  return (
    <div className="term">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

export function AgentRow(props: RowProps) {
  const { p } = props;
  const open = props.attention || (props.expanded && p.more);
  const status = p.status ?? 'unknown';
  let cls = `agent st-${status}`;
  if (p.framed && !props.attention) {
    cls += ' framed';
  }
  // Checked when the row draws, not on a clock: the flash is a fixed animation, so the class staying on a little
  // longer changes nothing, and it only starts again once the class came off and back.
  if (NEEDS_ICON[status] && p.since !== undefined && Date.now() - p.since < FRESH_MS) {
    cls += ' fresh';
  }
  let logoCls = 'avatar';
  if (p.agentKind) {
    logoCls += ' logo';
  }
  const pill = (
    <span className="state">
      {status === 'working' && <Icon name="sync" spin />}
      {NEEDS_ICON[status] && <Icon name={NEEDS_ICON[status]} />}
      {p.stateLabel ?? STATUS_LABEL[status] ?? status}
      {p.since && ' '}
      {p.since && <Since t={p.since} />}
    </span>
  );
  // Blocked and done agents show their screen; others the gist of their last reply. Never both.
  let story: ReactNode = null;
  if (p.preview.length) {
    story = <Lines lines={p.preview} />;
  } else if (p.headline && p.headline !== p.detail) {
    story = <div className="headline">{p.headline}</div>;
  }
  // The row's description when herdr.agentDescription chose one (Claude Haiku's summary, or your last message):
  // one line collapsed; open, the same text in full in the dark box the screen's lines use, and nothing else beside it.
  let desc: { line: ReactNode; full: ReactNode; title: string } | undefined;
  if (p.summary) {
    desc = {
      line: (
        <>
          <Icon name="sparkle" />
          {p.summary.text}
        </>
      ),
      full: (
        <>
          <Icon name="sparkle" />
          {p.summary.text} <Since t={p.summary.at} />
        </>
      ),
      title: 'Summary by Claude Haiku (herdr.agentDescription)',
    };
  } else if (p.request) {
    desc = { line: p.request, full: p.request, title: `You asked: ${p.request}` };
  }
  let body: ReactNode = null;
  if (open && desc) {
    body = (
      <>
        <div className="term desc" title={desc.title}>
          {desc.full}
        </div>
        <Extras p={p} />
      </>
    );
  } else if (open) {
    body = (
      <>
        {p.detail && <div className="sub">{p.detail}</div>}
        {story}
        <Extras p={p} />
      </>
    );
  } else if (desc) {
    body = (
      <div className="sub desc" title={desc.title}>
        {desc.line}
      </div>
    );
  } else if (p.detail || p.headline) {
    body = <div className="sub">{p.detail || p.headline}</div>;
  }
  return (
    <RowFrame
      {...props}
      expanded={!!open}
      className={cls}
      label={`${p.name}, ${p.stateLabel ?? STATUS_LABEL[status] ?? status}`}
      avatar={
        <div className={logoCls}>
          <AgentLogo kind={p.agentKind} fallback={p.agentKind || p.name || '?'} />
        </div>
      }
      line1={(name) => (
        <div className="line1">
          {name}
          {p.agentName && <span className="agent-name">{p.agentName}</span>}
          {pill}
        </div>
      )}
      body={body}
      side={
        <>
          {p.reviewable && (
            <span className="actions">
              <IconButton icon="diff" title="Review the changes in this agent's folder" onClick={() => post('review', { spaceId: p.spaceId, paneId: p.id })} />
            </span>
          )}
          {!props.attention && <Expander p={p} open={!!open} onExpand={props.onExpand} />}
        </>
      }
    />
  );
}

const SHELL_PILL: Record<ShellState, string> = { live: 'live output', running: 'running', prompt: 'at prompt', failed: 'error', unknown: '…' };

function Cmd({ sigil, text, typed }: { sigil: string; text: string; typed?: boolean }) {
  let cls = 'cmd';
  if (typed) {
    cls += ' typed';
  }
  return (
    <div className={cls}>
      <span className="sigil">{sigil}</span>
      <span className="text">{text}</span>
    </div>
  );
}

export function ShellRow(props: RowProps) {
  const { p } = props;
  const now = useNow();
  const st = shellState(p, now);
  const sh = p.shell;
  // One line of context: what runs now, else the last command, else what's typed.
  let main: ReactNode = null;
  if (sh?.command) {
    let sigil = '$';
    if (sh.state === 'running') {
      sigil = '▶';
    }
    main = <Cmd sigil={sigil} text={sh.command} />;
  } else if (sh?.typed) {
    main = <Cmd sigil="›" text={sh.typed} typed />;
  }
  const open = props.expanded && p.more;
  let body = main;
  if (open) {
    body = (
      <>
        {main}
        {sh?.command && sh.typed && <Cmd sigil="›" text={sh.typed} typed />}
        <Lines lines={sh?.output ?? []} />
        <Extras p={p} />
      </>
    );
  }
  const showSince = !!sh?.changedAt && (st === 'live' || st === 'running');
  return (
    <RowFrame
      {...props}
      expanded={open}
      className={`shell sh-${st}`}
      label={`${p.name}, shell, ${SHELL_PILL[st]}`}
      avatar={
        <div className="avatar">
          <Icon name="terminal" />
        </div>
      }
      line1={(name) => (
        <div className="line1">
          {name}
          <span className="state">
            {SHELL_PILL[st]}
            {showSince && ' '}
            {showSince && <Since t={sh!.changedAt!} />}
          </span>
        </div>
      )}
      body={body}
      side={<Expander p={p} open={open} onExpand={props.onExpand} />}
    />
  );
}
