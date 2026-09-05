import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const spec = JSON.parse(await readFile('/run/credentials/launch.json', 'utf8'));
if (!['claude', 'codex', 'node'].includes(spec.executable) || !Array.isArray(spec.args) || spec.cwd !== '/workspace') throw new Error('LAUNCH_SPEC_REFUSED');
const env = { HOME: '/home/worker', PATH: process.env.PATH, TERM: process.env.TERM ?? 'xterm-256color', CYBERDECK_REPORT_URL: process.env.CYBERDECK_REPORT_URL, ...spec.env };
if (spec.executable !== 'node') {
  const credential = JSON.parse(await readFile('/run/credentials/provider.json', 'utf8'));
  if (credential.provider !== spec.executable) throw new Error('PROVIDER_CREDENTIAL_MISMATCH');
  env[credential.provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] = credential.apiKey;
}
const child = spawn(spec.executable, spec.args, { cwd: '/workspace', stdio: 'inherit', env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 127; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
