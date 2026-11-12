// One Herdr pane as a controllable terminal stream: `herdr terminal session control <target>`.
// No vscode imports (tested with a fake herdr).
//
// Verified on herdr 0.9.1 and 0.9.3:
//  - stdout: NDJSON `{"type":"terminal.frame","encoding":"ansi","bytes":<base64>,"full":bool,"seq","width","height"}`
//    (a full repaint, then incremental ones), and `{"type":"terminal.closed","reason":...}` ("detached" after
//    a release). Frames paint the screen and the cursor only: the program's modes (mouse reporting,
//    bracketed paste, application cursor keys) are not passed on.
//  - stdin: NDJSON commands (unknown ones are rejected on stderr and ignored):
//      {"type":"terminal.input","bytes":<base64>}          (or "text")
//      {"type":"terminal.resize","cols":N,"rows":N}        (answered with a full frame)
//      {"type":"terminal.scroll","direction":"up"|"down","lines":N}   (lines: u16)
//      {"type":"terminal.release"}                         (detach; the program keeps running)
//    and, since 0.9.2 (verified on 0.9.3), {"type":"terminal.mouse","action":"down"|"up"|"drag"|"move",
//    "button":"left"|"right"|"middle","column":N,"row":N,"modifiers":shift 1|ctrl 2|alt 4}, which Herdr drops
//    unless the program enabled mouse reporting.
//  - One controller per terminal: --takeover replaces another one, whose stream then closes with the reason
//    "terminal attach taken over". Herdr doesn't say who took it (see hubFiles.ts, claims). Without
//    --takeover a second controller is refused ("already has an attached client; retry with --takeover").
//  - `herdr terminal session observe <target> --cols --rows` (verified on 0.9.3) streams the same frames
//    read-only, next to a controller: drawn at the observer's own size, stdin commands ignored (so a resize
//    means a new observer), and it keeps going when the controller releases. It closes with terminal.closed
//    when the pane goes away.
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

/** control: input, resize, scroll and mouse go to the pane (and it's taken over from whoever had it). observe: read-only. */
export type StreamMode = 'control' | 'observe';

/** The reason Herdr gives a controller whose pane another client took over. */
export const isTakenOver = (reason?: string) => !!reason && /taken over/i.test(reason);

export interface StreamHandlers {
  onFrame(bytes: Buffer, full: boolean): void;
  /** The stream ended: Herdr closed it (reason), the process exited, or it couldn't start (error). */
  onClose(info: { reason?: string; error?: string }): void;
}

export class HerdrStream {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private closed = false;
  private released = false;
  private stderr = '';

  constructor(
    bin: string,
    target: string,
    size: { cols: number; rows: number },
    env: NodeJS.ProcessEnv,
    private h: StreamHandlers,
    readonly mode: StreamMode = 'control',
  ) {
    const how = mode === 'observe' ? ['observe', target] : ['control', target, '--takeover'];
    this.proc = spawn(bin, ['terminal', 'session', ...how, '--cols', String(size.cols), '--rows', String(size.rows)], { env });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => this.read(d));
    this.proc.stderr.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    this.proc.on('error', (e) => this.close({ error: e.message }));
    this.proc.on('exit', (code) => this.close(code ? { error: this.stderr.trim() || `herdr exited with ${code}` } : {}));
    this.proc.stdin.on('error', () => {}); // the process went away; 'exit' reports it
  }

  private read(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.type === 'terminal.frame' && typeof rec.bytes === 'string') this.h.onFrame(Buffer.from(rec.bytes, 'base64'), !!rec.full);
      else if (rec?.type === 'terminal.closed') this.close({ reason: String(rec.reason ?? 'closed') });
    }
  }

  private send(cmd: object) {
    if (this.mode === 'control' && !this.closed && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(cmd) + '\n');
  }

  input(data: string | Buffer) {
    const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (b.length) this.send({ type: 'terminal.input', bytes: b.toString('base64') });
  }
  resize(cols: number, rows: number) {
    this.send({ type: 'terminal.resize', cols: Math.max(1, cols | 0), rows: Math.max(1, rows | 0) });
  }
  scroll(direction: 'up' | 'down', lines: number) {
    this.send({ type: 'terminal.scroll', direction, lines: Math.min(65535, Math.max(1, lines | 0)) });
  }

  /** A mouse event for the program in the pane (Herdr >= 0.9.2; older ones ignore it). Cells are 0-based. */
  mouse(action: 'down' | 'up' | 'drag' | 'move', button: 'left' | 'right' | 'middle', column: number, row: number, modifiers = 0) {
    this.send({ type: 'terminal.mouse', action, button, column: Math.max(0, column), row: Math.max(0, row), ...(modifiers && { modifiers }) });
  }

  /** The process is still running (it can outlive the stream: terminal.closed comes before it exits). */
  private running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null && !this.proc.killed;
  }

  /**
   * Detach (the program keeps running in Herdr), then stop the process. An observer just stops. A stream Herdr
   * already closed is past detaching, but its process may still be running: it's stopped all the same.
   */
  release() {
    if (this.released) {
      return;
    }
    this.released = true;
    if (!this.running()) {
      return;
    }
    if (this.mode === 'observe') {
      this.proc.kill();
      return;
    }
    this.send({ type: 'terminal.release' });
    this.proc.stdin.end();
    setTimeout(() => {
      if (this.running()) {
        this.proc.kill();
      }
    }, 1000).unref();
  }

  private close(info: { reason?: string; error?: string }) {
    if (this.closed) return;
    this.closed = true;
    this.h.onClose(info);
  }
}
