// The Usage section: each running agent's plan limits, session tokens or credits. Folds to one line of numbers.
import type { ReactNode } from 'react';
import type { UsageView } from '../../src/viewState';
import { shortCount } from '../../src/format';
import { post, type UiState } from './host';
import { AgentLogo, FoldHeading, Icon, Since, Until } from './ui';

type Update = (change: (ui: UiState) => UiState) => void;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const amount = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function Meter({ w }: { w: UsageView['windows'][number] }) {
  const pct = Math.round(w.usedPercent);
  let when: ReactNode = <span className="reset" />;
  if (w.reset) {
    when = (
      <span className="reset" title="This window has reset since the agent last reported its usage">
        reset
      </span>
    );
  } else if (w.resetsAt) {
    when = (
      <span className="reset" title={`Resets at ${new Date(w.resetsAt).toLocaleString()}`}>
        ↻ <Until t={w.resetsAt} />
      </span>
    );
  }
  return (
    <div className={`meter lvl-${w.level}`} title={`${w.label} window: ${pct}% used`}>
      <span className="ml">{w.label}</span>
      <span className="bar">
        <span className="fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="pct">{pct}%</span>
      {when}
    </div>
  );
}

function UsageRow({ u }: { u: UsageView }) {
  let fresh: ReactNode = null;
  if (u.live) {
    fresh = <span title="Fetched from the provider just now">live</span>;
  } else if (u.windows.length && u.asOf) {
    fresh = (
      <span title="When the agent last reported these numbers">
        as of <Since t={u.asOf} /> ago
      </span>
    );
  }
  let block: ReactNode = null;
  if (u.block) {
    const b = u.block;
    const tip = `Tokens Claude Code used ${clock(b.startsAt)}–${clock(b.endsAt)} on this machine (input + output + cache writes). Cache reads: ${shortCount(b.cacheRead)}.`;
    if (b.exact) {
      block = (
        <div className="ustat" title={tip}>
          This session: <b>{shortCount(b.tokens)}</b> tokens
        </div>
      );
    } else {
      block = (
        <div className="ustat" title={`${tip} The window is estimated from your first message; turn on plan limits for the exact one.`}>
          5-hour block (est.): <b>{shortCount(b.tokens)}</b> tokens · ends {clock(b.endsAt)}
        </div>
      );
    }
  }
  let credits: ReactNode = null;
  const c = u.credits;
  if (c) {
    let allowance = '';
    let tip = 'Kiro CLI credits used on this machine';
    if (c.limit) {
      allowance = ` / ${amount(c.limit)}`;
      tip += ' (your allowance comes from the herdr.kiroMonthlyCredits setting)';
    }
    credits = (
      <>
        <div className="ustat" title={tip}>
          <b>{amount(c.month)}</b>
          {allowance} credits this month · {amount(c.today)} today
        </div>
        {!c.limit && (
          <button className="link-btn" title="Kiro doesn't share your plan's allowance with other tools; enter it once to see a bar" onClick={() => post('setKiroCredits')}>
            <Icon name="edit" />
            Set monthly credits…
          </button>
        )}
      </>
    );
  }
  return (
    <div className="usage-row">
      <div className="avatar logo small">
        <AgentLogo kind={u.id} fallback={u.name} />
      </div>
      <div className="main">
        <div className="line1">
          <span className="name">{u.name}</span>
          <span className="umeta">
            {u.planName}
            {u.planName && fresh && ' · '}
            {fresh}
          </span>
        </div>
        {u.windows.map((w) => (
          <Meter key={w.label} w={w} />
        ))}
        {block}
        {credits}
        {!u.windows.length && !block && !credits && <div className="ustat">No usage recorded yet</div>}
        {u.canSetUpLimits && (
          <button className="link-btn" title="Claude Code shares plan limits only with a status line; set one up" onClick={() => post('setupClaudeUsage')}>
            <Icon name="graph" />
            Show plan limits…
          </button>
        )}
      </div>
    </div>
  );
}

export function UsageSection({ usage, ui, update }: { usage: UsageView[]; ui: UiState; update: Update }) {
  if (!usage.length) {
    return null;
  }
  const open = ui.usageOpen ?? true;
  return (
    <>
      <FoldHeading className="section-label usage-label" open={open} onToggle={() => update((u) => ({ ...u, usageOpen: !open }))}>
        Usage
        {!open && (
          <span className="usums">
            {usage.map((u) => (
              <span key={u.id} className={`usum lvl-${u.summary.level}`} title={u.name}>
                <AgentLogo kind={u.id} fallback={u.name} />
                {u.summary.text}
              </span>
            ))}
          </span>
        )}
      </FoldHeading>
      {open && (
        <div className="usage">
          {usage.map((u) => (
            <UsageRow key={u.id} u={u} />
          ))}
        </div>
      )}
    </>
  );
}
