// Connection screens and strips: why Herdr isn't connected (reasons from src/connection.ts) with the next step,
// the reconnecting / protocol banner, and the versions line at the bottom.
import type { ReactNode } from 'react';
import type { ViewState } from '../../src/viewState';
import { EXTENSION_NAME } from '../../src/brand';
import { post } from './host';
import { Icon } from './ui';

function Btn({ act, label, primary }: { act: string; label: string; primary?: boolean }) {
  let cls = 'btn secondary';
  if (primary) {
    cls = 'btn';
  }
  return (
    <button className={cls} onClick={() => post(act)}>
      {label}
    </button>
  );
}

function PathLine({ label, path }: { label: string; path?: string }) {
  if (!path) {
    return null;
  }
  return (
    <p className="path">
      {label} <code>{path}</code>
    </p>
  );
}

/** Help, diagnostics and Cockpit setup: on every connection screen, including while it's still connecting. */
function Links() {
  const link = (act: string, label: string) => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        post(act);
      }}
    >
      {label}
    </a>
  );
  return (
    <p className="links">
      {link('copyDiagnostics', 'Copy diagnostics')} · {link('setupHub', 'Set up Cockpit window')} · {link('openHelp', 'Help')}
    </p>
  );
}

interface Screen {
  icon: string;
  title: string;
  text: ReactNode;
  buttons: ReactNode;
  extra?: ReactNode;
}

export function Disconnected({ state }: { state: ViewState }) {
  const c = state.connection;
  if (c.kind === 'connecting' || c.kind === 'starting' || c.kind === 'reconnecting') {
    let title = 'Connecting to Herdr…';
    if (c.kind === 'starting') {
      title = 'Starting Herdr…';
    }
    return (
      <div className="splash">
        <div className="big">
          <Icon name="sync" spin />
        </div>
        <h2>{title}</h2>
        <Links />
      </div>
    );
  }
  let socketLabel = 'Socket:';
  if (c.customSocket) {
    socketLabel = 'Socket (from herdr.socketPath):';
  }
  let unreachable = "The server is running but didn't respond.";
  if (c.detail) {
    unreachable = `The server is running but didn't respond: ${c.detail}.`;
  }
  const screens: Record<string, Screen> = {
    'not-installed': {
      icon: 'cloud-download',
      title: "Herdr isn't installed",
      text: (
        <>
          {EXTENSION_NAME} shows and controls a Herdr server, and needs the <code>herdr</code> command.
        </>
      ),
      buttons: (
        <>
          <Btn act="openInstallDocs" label="Install Herdr" primary />
          <Btn act="refresh" label="Retry" />
          <Btn act="openSettings" label="Set herdr path" />
        </>
      ),
      extra: <PathLine label="Looked for" path={c.binary} />,
    },
    'not-running': {
      icon: 'debug-disconnect',
      title: "Herdr isn't running",
      text: 'Your spaces and agents live in the Herdr server. Start it in the background, or open Herdr here.',
      buttons: (
        <>
          <Btn act="startServer" label="Start Herdr" primary />
          <Btn act="openTui" label="Open Herdr TUI" />
          <Btn act="refresh" label="Retry" />
        </>
      ),
      extra: (
        <>
          <PathLine label={socketLabel} path={c.socket} />
          {c.customSocket && <Btn act="openSettings" label="Settings" />}
        </>
      ),
    },
    crashed: {
      icon: 'warning',
      title: 'Herdr stopped unexpectedly',
      text: 'Its socket was left behind; starting it again is safe. Herdr restores your spaces and tabs.',
      buttons: (
        <>
          <Btn act="startServer" label="Start Herdr" primary />
          <Btn act="openTui" label="Open Herdr TUI" />
          <Btn act="refresh" label="Retry" />
        </>
      ),
      extra: <PathLine label="Socket:" path={c.socket} />,
    },
    incompatible: {
      icon: 'versions',
      title: "This Herdr version isn't compatible",
      text: (
        <>
          Herdr {c.version || '?'} speaks protocol {c.protocol ?? '?'}; {EXTENSION_NAME} expects {c.expectedProtocol}. Update Herdr (<code>herdr update</code>) or Herdr
          Cockpit.
        </>
      ),
      buttons: <Btn act="refresh" label="Retry" primary />,
    },
    unreachable: {
      icon: 'debug-disconnect',
      title: "Herdr isn't answering",
      text: unreachable,
      buttons: (
        <>
          <Btn act="refresh" label="Retry" primary />
          <Btn act="openTui" label="Open Herdr TUI" />
        </>
      ),
      extra: <PathLine label="Socket:" path={c.socket} />,
    },
  };
  const sc = screens[c.reason ?? 'not-running'] ?? screens['not-running'];
  return (
    <div className="splash">
      <div className="big">
        <Icon name={sc.icon} />
      </div>
      <h2>{sc.title}</h2>
      <p>{sc.text}</p>
      <div className="btns">{sc.buttons}</div>
      {sc.extra}
      <Links />
    </div>
  );
}

/** A strip above the view while reconnecting, or when Herdr's protocol differs from this build's. */
export function Banner({ state }: { state: ViewState }) {
  const c = state.connection;
  if (c.kind === 'reconnecting') {
    return (
      <div className="banner" role="status">
        <Icon name="sync" spin />
        Reconnecting to Herdr…
      </div>
    );
  }
  if (c.kind === 'connected' && c.protocol && c.protocol !== c.expectedProtocol) {
    return (
      <div className="banner warn" title={`${EXTENSION_NAME} was built against protocol ${c.expectedProtocol}`}>
        <Icon name="warning" />
        Herdr {c.version || ''} uses protocol {c.protocol}; some details may be missing. Update {EXTENSION_NAME}.
      </div>
    );
  }
  return null;
}

/** Herdr Cockpit's version, and Herdr's while connected. */
export function Versions({ state }: { state: ViewState }) {
  const v = state.versions;
  if (!v) {
    return null;
  }
  return (
    <div className="versions">
      {EXTENSION_NAME} v{v.cockpit}
      {v.herdr && ` · Herdr ${v.herdr}`}
    </div>
  );
}
