// Small pieces every part of the sidebar uses: icons, buttons, foldable headings, relative times, agent logos.
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { ago, left } from '../../src/format';
import { useNow } from './host';

declare global {
  interface Window {
    /** Agent logos keyed by Herdr agent name (media/agent-icons.js, generated). */
    HERDR_AGENT_ICONS?: Record<string, string>;
  }
}

export function Icon({ name, spin }: { name: string; spin?: boolean }) {
  let cls = `codicon codicon-${name}`;
  if (spin) {
    cls += ' spin';
  }
  return <span className={cls} aria-hidden="true" />;
}

export function IconButton(props: { icon: string; title: string; className?: string; onClick: () => void; expanded?: boolean }) {
  const click = (e: MouseEvent) => {
    e.stopPropagation();
    props.onClick();
  };
  return (
    <button className={`icon-btn ${props.className ?? ''}`} title={props.title} aria-label={props.title} aria-expanded={props.expanded} onClick={click}>
      <Icon name={props.icon} />
    </button>
  );
}

/**
 * Props that make an element act as a button for the mouse and keyboard (Enter, Space), and a stop for the
 * arrow-key navigation (data-nav).
 */
export function pressable(onPress: () => void, extra: { expanded?: boolean; onKey?: (e: KeyboardEvent) => void } = {}) {
  return {
    role: 'button',
    tabIndex: 0,
    'data-nav': '',
    'aria-expanded': extra.expanded,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      onPress();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) {
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      } else if (extra.onKey) {
        extra.onKey(e);
      }
    },
  };
}

/** A heading that folds what's under it: chevron, label, and whatever else goes on its line. */
export function FoldHeading(props: { className: string; open: boolean; onToggle: () => void; title?: string; children: ReactNode }) {
  let chev = 'chev';
  if (!props.open) {
    chev += ' closed';
  }
  return (
    <div className={props.className} title={props.title} {...pressable(props.onToggle, { expanded: props.open })}>
      <span className={chev}>
        <Icon name="chevron-down" />
      </span>
      {props.children}
    </div>
  );
}

/** "12s", "4m", "1h 20m": time since `t`, kept current. */
export function Since({ t }: { t: number }) {
  const now = useNow();
  return <span className="t">{ago(now - t)}</span>;
}

/** Time left until `t`, kept current. */
export function Until({ t }: { t: number }) {
  const now = useNow();
  return <span className="t">{left(t - now)}</span>;
}

/** The agent's logo, or its first letter when there's none ("claude-code" and "claude" share one). */
export function AgentLogo({ kind, fallback }: { kind?: string; fallback: string }) {
  const logos = window.HERDR_AGENT_ICONS ?? {};
  const k = (kind ?? '').toLowerCase();
  const svg = logos[k] || logos[k.split(/[^a-z0-9]/)[0]];
  if (k && svg) {
    // Generated from @lobehub/icons-static-svg by scripts/gen-agent-icons.mjs: trusted markup.
    return <span className="logo-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return <>{fallback.charAt(0).toUpperCase()}</>;
}

/** The right-click menu's context for VS Code (webview/context menus in package.json). */
export function menuContext(o: object): string {
  return JSON.stringify({ ...o, preventDefaultContextMenuItems: true });
}
