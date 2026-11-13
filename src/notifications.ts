// The notifications Herdr Cockpit shows: an agent that needs you (one window of all those running it shows it),
// Herdr going away, and panes another client took over. The wording is notices.ts (unit-tested). Moved out of
// extension.ts's activate().
import * as vscode from 'vscode';
import { MESSAGE_PREFIX } from './brand';
import { Model, Pane, Space, findPane } from './model';
import { sleep } from './format';
import type { Conn } from './herdrSync';
import { claimNotification } from './hubFiles';
import { lostNotice, takenOverNotice } from './notices';
import type { AttachTerminals } from './terminals';

/** Each window waits this much more than a likelier one before claiming an agent notification (agentChanged()). */
const NOTIFY_STEP_MS = 300;
/** Panes taken over within this long are announced together (a space switch elsewhere takes all of them). */
const TAKEOVER_GROUP_MS = 600;

export interface NotificationDeps {
  model(): Model | undefined;
  conn(): Conn;
  socketPath(): string;
  terms: AttachTerminals;
  isOpenHere(space: Space): boolean;
  attachPane(space: Space, pane: Pane): Promise<void>;
  review(space: Space, pane?: Pane): Promise<unknown>;
  startHerdr(): Promise<boolean>;
  kick(): Promise<void>;
}

export class Notifications implements vscode.Disposable {
  /** Herdr's loss was announced: once per outage. */
  private lostNotified = false;
  private takenOver = new Map<string, string | undefined>();
  private takenOverTimer?: NodeJS.Timeout;

  constructor(private deps: NotificationDeps) {}

  /**
   * An agent's status changed to one in herdr.notifyOn. Every window running this extension sees the same change.
   * One of them shows it: the focused window first, then a window that has the space, then any other (each waits a
   * little longer before claiming it).
   */
  async agentChanged(space: Space, agent: Pane) {
    let wait = 2 * NOTIFY_STEP_MS;
    if (vscode.window.state.focused) {
      wait = 0;
    } else if (this.deps.isOpenHere(space)) {
      wait = NOTIFY_STEP_MS;
    }
    if (wait) {
      await sleep(wait);
    }
    const change = [this.deps.socketPath(), agent.id, agent.status, agent.raw.agent?.state_change_seq ?? Math.floor(Date.now() / 60_000)].join('\n');
    if (!claimNotification(change)) {
      return;
    }
    const msg = `${MESSAGE_PREFIX}: ${agent.label} in ${space.label} is ${agent.status}`;
    let actions = ['Attach'];
    if (agent.status === 'done') {
      actions = ['Review changes', 'Attach'];
    }
    let pick: string | undefined;
    if (agent.status === 'blocked') {
      pick = await vscode.window.showWarningMessage(msg, ...actions);
    } else {
      pick = await vscode.window.showInformationMessage(msg, ...actions);
    }
    if (!pick) {
      return;
    }
    // The click can come minutes later: act on the agent as Herdr has it now (it may have moved or closed).
    const now = findPane(this.deps.model(), agent.id);
    if (!now) {
      vscode.window.showInformationMessage(`${MESSAGE_PREFIX}: ${agent.label} isn't in Herdr anymore.`);
      return;
    }
    if (pick === 'Attach') {
      await this.deps.attachPane(now.space, now.pane);
    } else if (pick === 'Review changes') {
      await this.deps.review(now.space, now.pane);
    }
  }

  /** Connected again: the next loss is announced again. */
  connected() {
    this.lostNotified = false;
  }

  /** Herdr was connected and went away: say so once, since the agents stopped with it. */
  async lost() {
    const conn = this.deps.conn();
    if (conn.kind !== 'down' || this.lostNotified) {
      return;
    }
    this.lostNotified = true;
    const notice = lostNotice(conn.reason, conn.detail);
    const pick = await vscode.window.showWarningMessage(notice.message, ...notice.actions);
    if (pick === 'Start Herdr') {
      await this.deps.startHerdr();
    } else if (pick === 'Open Herdr TUI') {
      await vscode.commands.executeCommand('herdr.openTui');
    } else if (pick === 'Retry') {
      await this.deps.kick();
    }
  }

  /**
   * Another client took a pane over. The tabs keep showing their panes read-only (builtinTerminal.ts). Say so once
   * for the panes lost together (herdr.notifyOnTakeover).
   */
  tookOver(paneId: string, who: string | undefined) {
    if (!vscode.workspace.getConfiguration('herdr').get<boolean>('notifyOnTakeover', false)) {
      return;
    }
    this.takenOver.set(paneId, who);
    clearTimeout(this.takenOverTimer);
    this.takenOverTimer = setTimeout(() => void this.showTakenOver(), TAKEOVER_GROUP_MS);
  }

  private async showTakenOver() {
    const lost = [...this.takenOver];
    this.takenOver.clear();
    if (!lost.length) {
      return;
    }
    const { terms } = this.deps;
    const pick = await vscode.window.showWarningMessage(
      takenOverNotice(lost.map(([paneId, who]) => ({ name: terms.nameOf(paneId) ?? paneId, who }))),
      'Take Back',
      "Don't Show Again",
    );
    if (pick === 'Take Back') {
      terms.takeBack(lost.map(([paneId]) => paneId));
    } else if (pick === "Don't Show Again") {
      await vscode.workspace.getConfiguration('herdr').update('notifyOnTakeover', false, vscode.ConfigurationTarget.Global);
    }
  }

  dispose() {
    clearTimeout(this.takenOverTimer);
  }
}
