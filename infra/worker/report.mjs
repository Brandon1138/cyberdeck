import { readFile } from 'node:fs/promises';
// One bounded JSON report on stdin. This client has no generic broker request operation.
let body = '';
for await (const chunk of process.stdin) {
  body += chunk;
  if (Buffer.byteLength(body) > 65536) throw new Error('REPORT_TOO_LARGE');
}
const report = JSON.parse(body);
const token = (await readFile('/run/credentials/reporting-token', 'utf8')).trim();
const url = new URL(process.env.CYBERDECK_REPORT_URL);
if (url.hostname !== 'host.docker.internal' || url.protocol !== 'http:' || url.pathname !== '/v1/report') throw new Error('REPORT_URL_REFUSED');
const response = await fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(report), signal: AbortSignal.timeout(10000), redirect: 'error',
});
if (!response.ok) throw new Error(`REPORT_FAILED_${response.status}`);
process.stdout.write(await response.text());
