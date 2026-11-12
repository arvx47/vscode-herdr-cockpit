// The Herdr plugin (plugin/herdr-cockpit.sh) against a fake `herdr` and fake editor command lines that record
// their arguments. Runs the script with /bin/sh (and dash when installed), so it stays POSIX.
import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const script = path.join(__dirname, '..', '..', 'plugin', 'herdr-cockpit.sh');
// /bin/sh is bash (macOS) or dash (Debian, Ubuntu); also run dash wherever it's installed.
const shells = [...new Map(['/bin/sh', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s)).map((s) => [fs.realpathSync(s), s])).values()];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-plugin-'));
  const log = path.join(dir, 'calls.log');
  const hub = path.join(dir, 'hub');
  fs.mkdirSync(path.join(hub, 'editors'), { recursive: true });
  // Fake herdr: logs its argv; `pane get` answers with a foreground_cwd.
  const herdr = path.join(dir, 'herdr');
  fs.writeFileSync(
    herdr,
    `#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1 $2" in "pane get") printf '{"result":{"pane":{"cwd":"/x","foreground_cwd":"%s","pane_id":"%s"}}}\\n' "$FAKE_FG_CWD" "$3";; esac\n`,
    { mode: 0o755 },
  );
  /** A fake editor command line: logs its argv; --list-extensions answers from a file. */
  const editor = (name: string, extensions = '') => {
    const cli = path.join(dir, `bin-${name}`, name);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    const ext = path.join(dir, `${name}.extensions`);
    fs.writeFileSync(ext, extensions);
    fs.writeFileSync(
      cli,
      `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in --list-extensions) cat ${JSON.stringify(ext)};; --install-extension) echo sriharirao.herdr-cockpit >> ${JSON.stringify(ext)};; esac\n`,
      { mode: 0o755 },
    );
    return cli;
  };
  const record = (scheme: string, cli: string, updated: number, linkVersion = 1) =>
    fs.writeFileSync(
      path.join(hub, 'editors', `${scheme}.json`),
      JSON.stringify({ name: scheme, scheme, cli, extensionId: 'sriharirao.herdr-cockpit', extensionVersion: '0.1.0', linkVersion, platform: 'darwin', updated }, null, 2),
    );
  const env = (extra: Record<string, string> = {}) => ({
    PATH: '/usr/bin:/bin',
    HOME: dir,
    HERDR_BIN_PATH: herdr,
    HERDR_COCKPIT_DIR: hub,
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, 'config'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
    HERDR_COCKPIT_APP_DIRS: path.join(dir, 'Applications'),
    ...extra,
  });
  const run = (shell: string, args: string[], extra: Record<string, string> = {}, input = '') =>
    spawnSync(shell, [script, ...args], { env: env(extra), input, encoding: 'utf8', timeout: 20_000 });
  /** Calls logged so far (waits briefly: editor launches run in the background). */
  const calls = async (expect?: RegExp) => {
    for (let i = 0; i < 40; i++) {
      const s = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      if (!expect || expect.test(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  };
  const reset = () => fs.rmSync(log, { force: true });
  return { dir, hub, editor, record, run, calls, reset };
}

(async () => {
  for (const sh of shells) {
    const t = sandbox();
    const tag = `[${path.basename(sh)}]`;

    // parse-location: the forms compilers, linters, tracebacks and GitHub print
    const loc = (s: string) => t.run(sh, ['parse-location', s]).stdout.replace(/\n$/, '');
    assert.strictEqual(loc('src/app.ts:42:7'), 'src/app.ts\t42\t7');
    assert.strictEqual(loc('src/app.ts:42'), 'src/app.ts\t42\t');
    assert.strictEqual(loc('  `src/app.ts:42:7: error TS2322`  '), 'src/app.ts\t42\t7');
    assert.strictEqual(loc('src/app.ts(42,7)'), 'src/app.ts\t42\t7');
    assert.strictEqual(loc('src/app.ts#L42'), 'src/app.ts\t42\t');
    assert.strictEqual(loc('File "/srv/app.py", line 12, in main'), '/srv/app.py\t12\t');
    assert.strictEqual(loc('"/a b/c.md"'), '/a b/c.md\t\t');
    assert.strictEqual(loc('README.md.'), 'README.md\t\t');
    console.log(`✓ ${tag} file locations parsed`);

    // open: the most recently used editor gets the link, with the space, pane, label and session
    const vscode = t.editor('code', 'sriharirao.herdr-cockpit\n');
    const cursor = t.editor('cursor', 'sriharirao.herdr-cockpit\n');
    t.record('vscode', vscode, 1000);
    t.record('cursor', cursor, 2000);
    let r = t.run(sh, ['open'], {
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PANE_ID: 'w1:p2',
      HERDR_SESSION: 'work',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_label: 'my api & "web"', focused_pane_id: 'w1:p2' }),
      VSCODE_IPC_HOOK_CLI: '/tmp/other-window.sock',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    let log = await t.calls(/cursor --open-url/);
    assert.match(log, /^cursor --open-url cursor:\/\/sriharirao\.herdr-cockpit\/open\?v=1&space=w1&pane=w1%3Ap2&label=my%20api%20%26%20%22web%22&session=work$/m);
    const url = new URL(/--open-url (\S+)/.exec(log)![1]);
    assert.strictEqual(url.searchParams.get('label'), 'my api & "web"', 'label round-trips');
    t.reset();
    t.run(sh, ['open'], { HERDR_WORKSPACE_ID: 'w1', HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_label: 'café ü' }) });
    assert.strictEqual(new URL(/--open-url (\S+)/.exec(await t.calls(/open-url/))![1]).searchParams.get('label'), 'café ü', 'non-ASCII labels');
    console.log(`✓ ${tag} open: most recent editor, space/pane/label/session encoded (non-ASCII too)`);

    // config chooses the editor
    t.reset();
    fs.mkdirSync(path.join(t.dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'config', 'config.toml'), '# mine\neditor = "vscode"   # chosen\n');
    t.run(sh, ['review'], { HERDR_WORKSPACE_ID: 'w3', HERDR_PANE_ID: 'w3:p1' });
    log = await t.calls(/code --open-url/);
    assert.match(log, /^code --open-url vscode:\/\/sriharirao\.herdr-cockpit\/review\?v=1&space=w3&pane=w3%3Ap1$/m);
    console.log(`✓ ${tag} config.toml picks the editor; review link`);

    // open-file: relative paths resolve against the pane's live folder
    t.reset();
    const proj = path.join(t.dir, 'proj');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'a b.ts'), '');
    t.run(sh, ['open-file'], { HERDR_PANE_ID: 'w1:p1', FAKE_FG_CWD: proj, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: 'src/a b.ts:12:3', focused_pane_cwd: '/elsewhere' }) });
    log = await t.calls(/code --open-url/);
    const fileUrl = new URL(/code --open-url (\S+)/.exec(log)![1]);
    assert.deepStrictEqual([fileUrl.pathname, fileUrl.searchParams.get('path'), fileUrl.searchParams.get('line'), fileUrl.searchParams.get('col')], ['/file', path.join(proj, 'src', 'a b.ts'), '12', '3']);
    t.reset();
    t.run(sh, ['open-file'], { HERDR_PANE_ID: 'w1:p1', FAKE_FG_CWD: proj, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: 'src/a b.ts:7\nnext line\n' }) });
    assert.strictEqual(new URL(/code --open-url (\S+)/.exec(await t.calls(/open-url/))![1]).searchParams.get('line'), '7', 'a multi-line selection uses its first line');
    t.reset();
    t.run(sh, ['open-file'], { HERDR_PANE_ID: 'w1:p1', FAKE_FG_CWD: proj, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: 'missing.ts:3' }) });
    log = await t.calls(/notification/);
    assert.match(log, /herdr notification show Herdr Cockpit --body No such file: .*missing\.ts/);
    assert.doesNotMatch(log, /--open-url/);
    t.reset();
    t.run(sh, ['open-file'], { HERDR_PLUGIN_CONTEXT_JSON: '{}' });
    assert.match(await t.calls(/notification/), /Select a path first/);
    console.log(`✓ ${tag} open-file: relative to the pane's live folder, spaces kept, missing file and no selection reported`);

    // an old extension that doesn't speak this link version
    t.reset();
    fs.rmSync(path.join(t.dir, 'config'), { recursive: true });
    t.record('cursor', cursor, 3000, 0);
    t.run(sh, ['open'], { HERDR_WORKSPACE_ID: 'w1' });
    log = await t.calls(/notification/);
    assert.match(log, /Update the Herdr Cockpit extension in Cursor/);
    assert.doesNotMatch(log, /--open-url/);
    console.log(`✓ ${tag} old extension: asks for an update instead of sending a link it can't read`);

    // on-status: only with review_on_done, only for done
    t.reset();
    t.record('cursor', cursor, 3000);
    const ev = (status: string) => JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w2:p1', workspace_id: 'w2', agent_status: status } });
    t.run(sh, ['on-status'], { HERDR_PLUGIN_EVENT_JSON: ev('done') });
    assert.strictEqual(await t.calls(/open-url/), '', 'off by default');
    fs.mkdirSync(path.join(t.dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'config', 'config.toml'), 'review_on_done = true\n');
    t.run(sh, ['on-status'], { HERDR_PLUGIN_EVENT_JSON: ev('working') });
    t.run(sh, ['on-status'], { HERDR_PLUGIN_EVENT_JSON: ev('done') });
    log = await t.calls(/open-url/);
    assert.strictEqual(log.match(/open-url/g)?.length, 1);
    assert.match(log, /cursor --open-url cursor:\/\/sriharirao\.herdr-cockpit\/review\?v=1&space=w2&pane=w2%3Ap1/);
    console.log(`✓ ${tag} on-status: review when an agent is done, only when enabled`);

    // no editor known: open opens the setup popup, carrying what to do after
    t.reset();
    fs.rmSync(path.join(t.hub, 'editors'), { recursive: true });
    fs.rmSync(path.join(t.dir, 'config'), { recursive: true });
    t.run(sh, ['open'], { HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p1' });
    log = await t.calls(/plugin pane open/);
    assert.match(log, /herdr plugin pane open --plugin sriharirao\.vscode-herdr-cockpit --entrypoint setup --placement popup --focus --env HUB_PANE=w1:p1 --env HUB_SPACE=w1 --env HUB_AFTER=open/);
    console.log(`✓ ${tag} no editor yet: opens setup, then continues`);

    // setup (macOS layout): finds app bundles, installs the extension, saves the choice, binds keys, then opens
    if (process.platform === 'darwin') {
      t.reset();
      const app = (bundle: string, cli: string, extensions = '') => {
        const bin = path.join(t.dir, 'Applications', bundle, 'Contents', 'Resources', 'app', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        const ext = path.join(t.dir, `${bundle}.extensions`);
        fs.writeFileSync(ext, extensions);
        fs.writeFileSync(
          path.join(bin, cli),
          `#!/bin/sh\nprintf '${cli} %s\\n' "$*" >> ${JSON.stringify(path.join(t.dir, 'calls.log'))}\ncase "$1" in --list-extensions) cat ${JSON.stringify(ext)};; --install-extension) echo sriharirao.herdr-cockpit >> ${JSON.stringify(ext)};; esac\n`,
          { mode: 0o755 },
        );
      };
      app('Visual Studio Code.app', 'code');
      app('Kiro.app', 'code'); // Kiro ships only bin/code
      fs.mkdirSync(path.join(t.dir, 'xdg', 'herdr'), { recursive: true });
      fs.writeFileSync(path.join(t.dir, 'xdg', 'herdr', 'config.toml'), '[[keys.command]]\nkey = "prefix+shift+o"\ntype = "plugin_action"\ncommand = "someone.else"\n');
      r = t.run(sh, ['setup'], { HUB_AFTER: 'open', HUB_SPACE: 'w4', HUB_PANE: 'w4:p1' }, '2\n\ny\n\n');
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /1\) VS Code\n {2}2\) Kiro\n/);
      assert.match(r.stdout, /Installed\./);
      assert.match(r.stdout, /prefix\+shift\+o is already used/);
      assert.match(fs.readFileSync(path.join(t.dir, 'config', 'config.toml'), 'utf8'), /^editor = "kiro"$/m);
      const herdrCfg = fs.readFileSync(path.join(t.dir, 'xdg', 'herdr', 'config.toml'), 'utf8');
      assert.match(herdrCfg, /key = "prefix\+shift\+e"\ntype = "plugin_action"\ncommand = "sriharirao\.vscode-herdr-cockpit\.open"/);
      assert.doesNotMatch(herdrCfg, /vscode-herdr-cockpit\.open-file/);
      log = await t.calls(/open-url/);
      assert.match(log, /code --install-extension sriharirao\.herdr-cockpit/);
      assert.match(log, /herdr server reload-config/);
      assert.match(log, /code --open-url kiro:\/\/sriharirao\.herdr-cockpit\/open\?v=1&space=w4&pane=w4%3Ap1/);
      console.log(`✓ ${tag} setup: finds app bundles (Kiro's bin/code), installs, saves the editor, binds a free key, then opens`);
    }

    // setup (Linux): editors are found on PATH
    if (process.platform === 'linux') {
      t.reset();
      const bin = path.join(t.dir, 'linux-bin');
      fs.mkdirSync(bin, { recursive: true });
      for (const c of ['code', 'cursor'])
        fs.writeFileSync(path.join(bin, c), `#!/bin/sh\nprintf '${c} %s\\n' "$*" >> ${JSON.stringify(path.join(t.dir, 'calls.log'))}\ncase "$1" in --list-extensions) echo sriharirao.herdr-cockpit;; esac\n`, { mode: 0o755 });
      r = t.run(sh, ['setup'], { PATH: `${bin}:/usr/bin:/bin`, HUB_AFTER: 'open', HUB_SPACE: 'w5' }, '2\nn\nn\n\n');
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /1\) VS Code\n {2}2\) Cursor\n/);
      assert.match(r.stdout, /Cursor has Herdr Cockpit/);
      assert.match(fs.readFileSync(path.join(t.dir, 'config', 'config.toml'), 'utf8'), /^editor = "cursor"$/m);
      assert.match(await t.calls(/open-url/), /cursor --open-url cursor:\/\/sriharirao\.herdr-cockpit\/open\?v=1&space=w5/);
      console.log(`✓ ${tag} setup (Linux): editors on PATH, extension already there, then opens`);
    }

    // status: reads the Cockpit window's file
    const st = sandbox();
    const cli = st.editor('cursor', 'sriharirao.herdr-cockpit\n');
    st.record('cursor', cli, 1);
    fs.mkdirSync(path.join(st.hub, 'status'), { recursive: true });
    fs.writeFileSync(
      path.join(st.hub, 'status', 'cursor.json'),
      JSON.stringify({ editor: 'Cursor', scheme: 'cursor', pid: process.pid, connected: true, state: 'connected', space: 'api', tabs: 3, agents: { working: 1, blocked: 2, done: 0, idle: 4 }, extensionVersion: '0.1.0', updated: Date.now() }, null, 2),
    );
    r = st.run(sh, ['status'], {}, '\n');
    assert.match(r.stdout, /Cockpit window: connected, space "api", 3 tabs open\n {4}agents: 1 working, 2 blocked, 0 done, 4 idle/);
    fs.writeFileSync(path.join(st.hub, 'status', 'cursor.json'), JSON.stringify({ pid: 999999, connected: true, updated: Date.now() }, null, 2));
    assert.match(st.run(sh, ['status'], {}, '\n').stdout, /Cockpit window: not open/, 'dead process');
    // pid 0 / -1 / 1 aren't a window: `kill -0 0` and `kill -0 -1` succeed (process group, every process).
    for (const pid of [0, -1, 1, '"12x"']) {
      fs.writeFileSync(path.join(st.hub, 'status', 'cursor.json'), `{\n  "pid": ${pid},\n  "connected": true,\n  "updated": ${Date.now()}\n}`);
      assert.match(st.run(sh, ['status'], {}, '\n').stdout, /Cockpit window: not open/, `pid ${pid}`);
    }
    console.log(`✓ ${tag} status popup`);

    fs.rmSync(t.dir, { recursive: true, force: true });
    fs.rmSync(st.dir, { recursive: true, force: true });
  }
  // The manifest parses as TOML Herdr accepts is checked by `herdr plugin link` (see CLAUDE.md); here, at least
  // every command points at the script's real subcommands.
  const manifest = fs.readFileSync(path.join(__dirname, '..', '..', 'plugin', 'herdr-plugin.toml'), 'utf8');
  for (const m of manifest.matchAll(/"herdr-cockpit\.sh\\?"?,? ?"?([a-z-]+)/g)) assert.match(fs.readFileSync(script, 'utf8'), new RegExp(`^${m[1]}\\)`, 'm'), `subcommand ${m[1]}`);
  execFileSync('/bin/sh', ['-n', script]);
  console.log('\nplugin tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
