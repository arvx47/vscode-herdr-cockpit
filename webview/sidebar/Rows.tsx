// Agent and shell rows: two lines (name + status, then one line of context); the chevron reveals the rest.
import type { KeyboardEvent, ReactNode } from 'react';
import type { PaneView } from '../../src/viewState';
import { post, useNow } from './host';
import { AgentLogo, Icon, IconButton, menuContext, pressable, Since } from './ui';

const STATUS_LABEL: Record<string, string> = { blocked: 'Blocked', done: 'Done', working: 'Working', idle: 'Idle', unknown: 'Unknown' };
/** A shell counts as showing live output this long after its output last changed. */
const LIVE_MS = 12000;

export type ShellState = 'live' | 'running' | 'prompt' | 'failed' | 'unknown';

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

interface RowProps {
  p: PaneView;
  expanded: boolean;
  onExpand: (open: boolean) => void;
  /** In the Needs you list: always expanded, with its space's name. */
  attention?: boolean;
}

/** What every row shares: the frame, click to attach, the right-click menu, keyboard expand/collapse. */
function RowFrame(props: RowProps & { className: string; avatar: ReactNode; line1: ReactNode; body: ReactNode; side: ReactNode }) {
  const { p } = props;
  let cls = `row ${props.className}`;
  if (p.focused) {
    cls += ' herdr-focused';
  }
  if (props.expanded) {
    cls += ' open';
  }
  let hint = 'Click to open it in a terminal tab';
  if (p.attached) {
    hint = 'Click to show its terminal tab';
  }
  const onKey = (e: KeyboardEvent) => {
    if (!props.attention && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      props.onExpand(e.key === 'ArrowRight');
    }
  };
  return (
    <div
      className={cls}
      title={`${p.name} · ${p.id}\n${hint}`}
      data-vscode-context={menuContext({ webviewSection: p.kind, spaceId: p.spaceId, paneId: p.id, spaceHere: p.spaceMounted })}
      {...pressable(() => post('attach', { spaceId: p.spaceId, paneId: p.id }), { onKey })}
    >
      {props.avatar}
      <div className="main">
        {props.line1}
        {props.attention && <div className="where">{p.spaceLabel}</div>}
        {props.body}
      </div>
      <div className="side">{props.side}</div>
    </div>
  );
}

function Expander({ open, onExpand }: { open: boolean; onExpand: (open: boolean) => void }) {
  let icon = 'chevron-down';
  let title = 'Show details';
  if (open) {
    icon = 'chevron-up';
    title = 'Hide details';
  }
  return <IconButton className="expander" icon={icon} title={title} expanded={open} onClick={() => onExpand(!open)} />;
}

/** Expanded-only extras: chips, then the folder when it isn't the space's. */
function Extras({ p, more }: { p: PaneView; more?: ReactNode }) {
  const hasChips = !!more || !!p.tab || p.chips.length > 0;
  return (
    <>
      {hasChips && (
        <div className="chips">
          {more}
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
  const open = props.attention || props.expanded;
  const status = p.status ?? 'unknown';
  let cls = `agent st-${status}`;
  if (p.framed && !props.attention) {
    cls += ' framed';
  }
  let logoCls = 'avatar';
  if (p.agentKind) {
    logoCls += ' logo';
  }
  const pill = (
    <span className="state">
      {status === 'working' && <Icon name="sync" spin />}
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
  let body: ReactNode = null;
  if (open) {
    let kindChip: ReactNode = null;
    if (p.agentKind && p.agentKind.toLowerCase() !== p.name.toLowerCase()) {
      kindChip = (
        <span className="chip">
          <Icon name="hubot" />
          {p.agentKind}
        </span>
      );
    }
    body = (
      <>
        {p.detail && <div className="sub">{p.detail}</div>}
        {story}
        <Extras p={p} more={kindChip} />
      </>
    );
  } else if (p.detail || p.headline) {
    body = <div className="sub">{p.detail || p.headline}</div>;
  }
  return (
    <RowFrame
      {...props}
      expanded={!!open}
      className={cls}
      avatar={
        <div className={logoCls}>
          <AgentLogo kind={p.agentKind} fallback={p.agentKind || p.name || '?'} />
        </div>
      }
      line1={
        <div className="line1">
          <span className="name">{p.name}</span>
          {pill}
        </div>
      }
      body={body}
      side={
        <>
          <span className="actions">
            <IconButton icon="diff" title="Review the changes in this agent's folder" onClick={() => post('review', { spaceId: p.spaceId, paneId: p.id })} />
          </span>
          {!props.attention && <Expander open={props.expanded} onExpand={props.onExpand} />}
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
  let body = main;
  if (props.expanded) {
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
      className={`shell sh-${st}`}
      avatar={
        <div className="avatar">
          <Icon name="terminal" />
        </div>
      }
      line1={
        <div className="line1">
          <span className="name">{p.name}</span>
          <span className="state">
            {SHELL_PILL[st]}
            {showSince && ' '}
            {showSince && <Since t={sh!.changedAt!} />}
          </span>
        </div>
      }
      body={body}
      side={<Expander open={props.expanded} onExpand={props.onExpand} />}
    />
  );
}
