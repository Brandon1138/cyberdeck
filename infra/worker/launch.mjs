import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { applyAuthentication } from './auth.mjs';
const spec = JSON.parse(await readFile('/run/credentials/launch.json', 'utf8'));
if (!['claude', 'codex', 'node'].includes(spec.executable) || !Array.isArray(spec.args) || spec.cwd !== '/workspace') throw new Error('LAUNCH_SPEC_REFUSED');
const env = { HOME: '/home/worker', PATH: process.env.PATH, TERM: process.env.TERM ?? 'xterm-256color', CYBERDECK_REPORT_URL: process.env.CYBERDECK_REPORT_URL, ...spec.env };
if (spec.networkRestricted === true) {
  const policy = JSON.parse(await readFile('/run/credentials/network-policy.json', 'utf8'));
  const deadline = Date.now() + 60000;
  for (;;) {
    const ready = await readFile('/run/credentials/network-ready', 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (ready === policy.nonce) break;
    if (Date.now() >= deadline) throw new Error('NETWORK_BOUNDARY_UNAVAILABLE');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const proxy = `http://host.docker.internal:${policy.proxyPort}`;
  Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
    NO_PROXY: `localhost,127.0.0.1,host.docker.internal:${policy.reportPort}`,
    no_proxy: `localhost,127.0.0.1,host.docker.internal:${policy.reportPort}` });
}
if (spec.executable !== 'node') {
  const credential = JSON.parse(await readFile('/run/credentials/provider.json', 'utf8'));
  await applyAuthentication(credential, spec.executable, env);
  if (credential.kind === 'codex-subscription') spec.args.unshift('-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"');
}
// Provider/model execution begins only after this generation is registered and authoritative.
const token = (await readFile('/run/credentials/reporting-token', 'utf8')).trim();
const ready = new URL(process.env.CYBERDECK_REPORT_URL);
if (ready.hostname !== 'host.docker.internal' || ready.protocol !== 'http:' || ready.pathname !== '/v1/report') throw new Error('REPORT_URL_REFUSED');
ready.pathname = '/v1/ready';
const deadline = Date.now() + 30000;
for (;;) {
  const response = await fetch(ready, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000), redirect: 'error' });
  await response.body?.cancel();
  if (response.ok) break;
  if (response.status !== 409 || Date.now() >= deadline) throw new Error('BROKER_ACTIVATION_UNAVAILABLE');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const child = spawn(spec.executable, spec.args, { cwd: '/workspace', stdio: 'inherit', env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 127; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1); });
