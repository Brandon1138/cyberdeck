#!/usr/bin/env bash
# A fresh WSL2 user's source build and packed npm install, with no authenticated provider.
set -euo pipefail
umask 077
cd /home/cyberdeck-ci/source
node_version=24.18.0
node_archive="node-v${node_version}-linux-x64.tar.xz"
curl --fail --location --retry 3 --output "/tmp/$node_archive" "https://nodejs.org/dist/v${node_version}/$node_archive"
curl --fail --location --retry 3 --output /tmp/node-checksums.txt "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
cd /tmp
grep "  $node_archive$" node-checksums.txt | sha256sum --check --strict
mkdir /home/cyberdeck-ci/node
tar -xJf "$node_archive" --strip-components=1 -C /home/cyberdeck-ci/node
export PATH="/home/cyberdeck-ci/node/bin:$PATH"
node --version
corepack enable
cd /home/cyberdeck-ci/source
pnpm install --frozen-lockfile
pnpm check
pnpm build
npm pack --ignore-scripts --json > /tmp/cyberdeck-pack.json
package_file=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.parse(readFileSync("/tmp/cyberdeck-pack.json", "utf8"))[0].filename)')
install_root=/home/cyberdeck-ci/installed
npm install --global --prefix "$install_root" "./$package_file"
export XDG_STATE_HOME=/home/cyberdeck-ci/private-state
"$install_root/bin/cyberdeck" --version
"$install_root/bin/cyberdeck" --help
"$install_root/bin/cyberdeck" broker start
trap '"$install_root/bin/cyberdeck" broker stop' EXIT
"$install_root/bin/cyberdeck" broker status
"$install_root/bin/cyberdeck" broker stop
trap - EXIT
# Loading the addon is insufficient: prove a real shell can start in the installed PTY.
export CYBERDECK_TEST_INSTALLED_ROOT="$install_root/lib/node_modules/@ishmael38/cyberdeck"
node --input-type=module <<'NODE'
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require = createRequire(resolve(process.env.CYBERDECK_TEST_INSTALLED_ROOT, 'package.json'));
const pty = require('node-pty');
const child = pty.spawn('/bin/sh', ['-c', 'printf cyberdeck-wsl-pty'], {env: process.env});
let output = '';
const deadline = setTimeout(() => {child.kill(); console.error('Installed WSL PTY timed out'); process.exitCode = 1;}, 5000);
child.onData(data => {output += data;});
child.onExit(({exitCode}) => {clearTimeout(deadline); if (exitCode !== 0 || !output.includes('cyberdeck-wsl-pty')) throw new Error('Installed WSL PTY failed');});
NODE
