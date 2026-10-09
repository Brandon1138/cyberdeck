// Real WSL -> PowerShell STA -> PNG transfer, using only an artificial CI clipboard image.
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const root = '/home/cyberdeck-ci/installed/lib/node_modules/@ishmael38/cyberdeck';
const {capturePasteboardImage} = await import(pathToFileURL(`${root}/dist/src/client/clipboard-image.js`).href);
const captureStarted = performance.now();
const result = await capturePasteboardImage({directory: '/home/cyberdeck-ci/clipboard'});
const diagnostic = JSON.stringify({...result, elapsedMs: Math.round(performance.now() - captureStarted)});
if (process.argv[2] === 'empty') {
  assert.equal(result.status, 'no-image', diagnostic);
} else {
  assert.equal(result.status, 'captured', diagnostic);
  const png = await readFile(result.path);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(png.readUInt32BE(16), 3);
  assert.equal(png.readUInt32BE(20), 2);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
}
console.log(`WSL Windows clipboard ${process.argv[2]} passed`);
