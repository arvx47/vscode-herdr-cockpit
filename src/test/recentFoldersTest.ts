// Which recent folders New space… offers (src/commands/recentFolders.ts).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recentFolders } from '../commands/recentFolders';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-recent-'));
const dir = (...p: string[]) => {
  const d = path.join(home, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const app = dir('code', 'app');
const web = dir('code', 'web');
const spaced = dir('code', 'spaced');
const linked = dir('code', 'app-fix');
fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${app}/.git/worktrees/app-fix\n`);
const sub = dir('code', 'web', 'lib');
fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/lib\n');
const herdrWt = dir('.herdr', 'worktrees', 'app', 'out-1');
const hub = dir('.herdr-cockpit');
const gone = path.join(home, 'code', 'gone');

try {
  // Newest first, once each; no space folders, worktrees, the Cockpit folder or missing folders
  assert.deepStrictEqual(
    recentFolders([web, spaced, linked, herdrWt, hub, gone, app, web + '/', sub], [spaced], home),
    [web, app, sub],
  );
  // Capped
  assert.deepStrictEqual(recentFolders([app, web, sub], [], home, 2), [app, web]);
  console.log('recentFoldersTest: ok');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
