// What this window writes under ~/.herdr-cockpit for the Herdr plugin and the other windows (hubFiles.ts): the
// editor record, this window's folders and open spaces, and the Cockpit window's status (on change, plus a 30s
// heartbeat). Moved out of extension.ts's activate().
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { errorText } from './herdrClient';
import { countByStatus, Model, Space } from './model';
import type { Conn } from './herdrSync';
import { editorCli, HubStatus, LINK_VERSION, pruneClaims, removeHubStatus, removeWindowRecord, WindowRecord, writeEditorRecord, writeHubStatus, writeWindowRecord } from './hubFiles';

export interface CockpitFilesDeps {
  extensionId: string;
  extensionVersion: string;
  log(line: string): void;
  isHubWindow(): boolean;
  /** This window's folders (normalized). */
  myFolders(): string[];
  isOpenHere(space: Space): boolean;
  socketPath(): string;
  session(): string | undefined;
  model(): Model | undefined;
  conn(): Conn;
  /** The space of this window's tabs, and how many tabs it has. */
  tabs(): { space?: string; count: number };
}

export class CockpitFiles implements vscode.Disposable {
  private scheme = vscode.env.uriScheme;
  private lastWindowRecord = '';
  private lastHubStatus = '';
  private hubStatusAt = 0;
  private timer?: NodeJS.Timeout;
  private heartbeat: NodeJS.Timeout;

  constructor(private deps: CockpitFilesDeps) {
    this.writeEditorRecord();
    try {
      pruneClaims();
    } catch {
      // best effort
    }
    this.heartbeat = setInterval(() => this.writeNow(), 30_000);
  }

  /** Tell the Herdr plugin this editor has Herdr Cockpit, and how to start it from a terminal. */
  private writeEditorRecord() {
    try {
      let applicationName: string | undefined;
      try {
        applicationName = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).applicationName;
      } catch {
        // no product.json: fall back to `code`
      }
      writeEditorRecord({
        name: vscode.env.appName,
        scheme: this.scheme,
        cli: editorCli(vscode.env.appRoot, applicationName),
        extensionId: this.deps.extensionId,
        extensionVersion: this.deps.extensionVersion,
        linkVersion: LINK_VERSION,
        platform: process.platform,
        updated: Date.now(),
      });
    } catch (e) {
      this.deps.log(`could not write the editor record: ${errorText(e)}`);
    }
  }

  /** Something changed: write the files once things settle (debounced). */
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.writeNow(), 500);
  }

  private writeNow() {
    this.recordWindow();
    if (this.deps.isHubWindow()) {
      this.writeHubStatus();
    }
  }

  /** Record this window's folders and open spaces for the other windows (written only when they change). */
  private recordWindow() {
    const me = { scheme: this.scheme, pid: process.pid };
    try {
      const folders = this.deps.myFolders();
      if (!folders.length) {
        if (this.lastWindowRecord) {
          removeWindowRecord(me.scheme, me.pid);
        }
        this.lastWindowRecord = '';
        return;
      }
      const wsf = vscode.workspace.workspaceFile;
      // What brings this window forward: its workspace file, or its single folder.
      let focus: string | undefined;
      if (wsf?.scheme === 'file') {
        focus = wsf.fsPath;
      } else if (folders.length === 1 && !wsf) {
        focus = folders[0];
      }
      const spaces = (this.deps.model()?.spaces ?? []).filter((s) => this.deps.isOpenHere(s)).map((s) => s.label);
      const rec: WindowRecord = { ...me, socket: this.deps.socketPath(), folders, spaces, ...(focus && { focus }), updated: 0 };
      const key = JSON.stringify(rec);
      if (key === this.lastWindowRecord) {
        return;
      }
      this.lastWindowRecord = key;
      writeWindowRecord({ ...rec, updated: Date.now() });
    } catch (e) {
      this.deps.log(`could not record this window: ${errorText(e)}`);
    }
  }

  /** The Cockpit window's state, for the plugin's status pane. */
  private writeHubStatus() {
    const model = this.deps.model();
    const conn = this.deps.conn();
    const { working, blocked, done, idle } = countByStatus(model);
    const tabs = this.deps.tabs();
    let state: string = conn.kind;
    if (conn.kind === 'down') {
      state = conn.reason;
    }
    const s: Omit<HubStatus, 'updated'> = {
      editor: vscode.env.appName,
      scheme: this.scheme,
      pid: process.pid,
      connected: conn.kind === 'connected',
      state,
      session: this.deps.session(),
      space: model?.spaces.find((x) => x.id === tabs.space)?.label,
      tabs: tabs.count,
      agents: { working, blocked, done, idle },
      extensionVersion: this.deps.extensionVersion,
    };
    const key = JSON.stringify(s);
    if (key === this.lastHubStatus && Date.now() - this.hubStatusAt < 30_000) {
      return;
    }
    this.lastHubStatus = key;
    this.hubStatusAt = Date.now();
    try {
      writeHubStatus({ ...s, updated: this.hubStatusAt });
    } catch {
      // best effort
    }
  }

  dispose() {
    clearInterval(this.heartbeat);
    clearTimeout(this.timer);
    if (this.deps.isHubWindow()) {
      removeHubStatus(this.scheme, process.pid);
    }
    removeWindowRecord(this.scheme, process.pid);
  }
}
