// The sidebar: status counters, Needs you, Spaces, then Usage at the bottom. Draws the ViewState that
// src/panel.ts posts (built by src/viewState.ts, where the decisions live and are tested).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ViewState } from '../../src/viewState';
import { post, ready, useUiState } from './host';
import { AgentRow } from './Rows';
import { SpacesSection } from './Spaces';
import { Banner, Disconnected, Versions } from './Status';
import { Icon } from './ui';
import { UsageSection } from './Usage';

const COUNTED = ['blocked', 'done', 'working', 'idle'] as const;
const STATUS_ICON: Record<string, string> = { blocked: 'warning', done: 'pass-filled', working: 'sync', idle: 'circle-filled' };

/** Agents by status across every space; blocked and done jump to the agent that needs you. */
function Counters({ state }: { state: ViewState }) {
  const t = state.totals;
  const shown = COUNTED.filter((s) => t[s]);
  if (!shown.length) {
    return (
      <div className="top">
        <div className="stats">
          <span className="stat quiet">
            {state.spaces.length} spaces · {t.agents} agents
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="top">
      <div className="stats">
        {shown.map((s) => {
          const inner = (
            <>
              <Icon name={STATUS_ICON[s]} spin={s === 'working'} />
              <span className="n">{t[s]}</span> {s}
            </>
          );
          if (s === 'blocked' || s === 'done') {
            return (
              <button key={s} className={`stat st-${s}`} title="Jump to the agent that needs you" onClick={() => post('attention')}>
                {inner}
              </button>
            );
          }
          return (
            <span key={s} className={`stat st-${s}`} title={`${t[s]} ${s}`}>
              {inner}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Says an agent now waits on you, for screen readers (the list itself changes silently). */
function useAnnouncement(state: ViewState | undefined): string {
  const seen = useRef(new Map<string, string | undefined>());
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!state?.connected) {
      return;
    }
    const lines: string[] = [];
    const first = seen.current.size === 0;
    const next = new Map<string, string | undefined>();
    for (const sp of state.spaces) {
      for (const a of sp.agents) {
        next.set(a.id, a.status);
        const before = seen.current.get(a.id);
        if (!first && before !== a.status && (a.status === 'blocked' || a.status === 'done')) {
          lines.push(`${a.name} in ${sp.label} is ${a.status}`);
        }
      }
    }
    seen.current = next;
    if (lines.length) {
      setMessage(lines.join('. '));
    }
  }, [state]);
  return message;
}

/** Up and Down move between rows, headings and buttons that take part (data-nav), skipping hidden ones. */
function onArrows(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
    return;
  }
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')].filter((n) => n.offsetParent);
  const i = all.indexOf((e.target as HTMLElement).closest('[data-nav]') as HTMLElement);
  let step = -1;
  if (e.key === 'ArrowDown') {
    step = 1;
  }
  const next = all[Math.max(0, Math.min(all.length - 1, i + step))];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

export function App() {
  const [state, setState] = useState<ViewState>();
  const [ui, update] = useUiState();
  const announcement = useAnnouncement(state);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'state') {
        setState(e.data.state as ViewState);
      }
    };
    window.addEventListener('message', onMessage);
    ready();
    return () => window.removeEventListener('message', onMessage);
  }, []);
  if (!state) {
    return null;
  }
  const live = (
    <div className="sr-only" aria-live="polite">
      {announcement}
    </div>
  );
  if (!state.connected) {
    return (
      <>
        <Disconnected state={state} />
        <Versions state={state} />
        {live}
      </>
    );
  }
  let body = 'body';
  if (state.connection.kind === 'reconnecting') {
    body += ' stale';
  }
  return (
    <div onKeyDown={onArrows}>
      <Counters state={state} />
      <Banner state={state} />
      <div className={body}>
        {state.attention.length > 0 && (
          <>
            <div className="section-label">
              Needs you <span className="count">{state.attention.length}</span>
            </div>
            <div className="attention">
              {state.attention.map((a) => (
                <AgentRow key={a.id} p={a} attention expanded onExpand={() => undefined} />
              ))}
            </div>
          </>
        )}
        <SpacesSection state={state} ui={ui} update={update} />
        <UsageSection usage={state.usage} ui={ui} update={update} />
      </div>
      <Versions state={state} />
      {live}
    </div>
  );
}
