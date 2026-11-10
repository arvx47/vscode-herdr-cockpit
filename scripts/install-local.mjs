#!/usr/bin/env node
// Installs the packaged vsix in VS Code: the default profile, plus every other profile that already has the
// extension (`code --install-extension` alone only updates the default one).
//
//   npm run install-local   (packages first)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const vsix = `${pkg.name}-${pkg.version}.vsix`;

const user =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Code', 'User')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Code', 'User');

/** Profiles (other than the default) whose extension list has this extension. */
function profilesWithExtension() {
  const storage = join(user, 'globalStorage', 'storage.json');
  if (!existsSync(storage)) {
    return [];
  }
  const profiles = JSON.parse(readFileSync(storage, 'utf8')).userDataProfiles ?? [];
  return profiles.filter((p) => {
    const list = join(user, 'profiles', p.location, 'extensions.json');
    return existsSync(list) && readFileSync(list, 'utf8').includes(`"${id}"`);
  });
}

function install(profile) {
  const args = ['--install-extension', vsix, '--force'];
  if (profile) {
    args.push('--profile', profile);
  }
  console.log(`installing ${vsix} in the ${profile ?? 'default'} profile`);
  execFileSync('code', args, { stdio: 'inherit' });
}

install();
for (const p of profilesWithExtension()) {
  install(p.name);
}
