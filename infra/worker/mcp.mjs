import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
const workerId = process.argv[process.argv.indexOf('--actor-session') + 1];
if (!/^[a-f0-9-]{36}$/.test(workerId ?? '')) throw new Error('WORKER_ID_REQUIRED');
const kinds = { cyberdeck_report_progress: 'PROGRESS', cyberdeck_signal_exception: 'EXCEPTION', cyberdeck_signal_risk: 'RISK', cyberdeck_request_decision: 'DECISION_REQUEST', cyberdeck_respond_checkpoint: 'CHECKPOINT' };
const send = async (args, name) => {
  const token = (await readFile('/run/credentials/reporting-token','utf8')).trim();
  const url = new URL(process.env.CYBERDECK_REPORT_URL);
  if (url.hostname !== 'host.docker.internal' || url.protocol !== 'http:' || url.pathname !== '/v1/report') throw new Error('REPORT_URL_REFUSED');
  if (typeof args.summary !== 'string' || typeof args.eventId !== 'string') throw new Error('REPORT_ARGUMENTS_REQUIRED');
  const report = { workerId, eventId: args.eventId, kind: kinds[name], summary: args.summary,
    ...(name === 'cyberdeck_request_decision' ? { interventionRequired: true, continuation: 'awaiting-response' } : {}),
    ...(args.checkpointCorrelationId ? { checkpointCorrelationId: args.checkpointCorrelationId } : {}) };
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(report), signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error(`REPORT_FAILED_${response.status}`);
  return await response.json();
};
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (Buffer.byteLength(line) > 65536) throw new Error('MCP_FRAME_TOO_LARGE');
  let frame;
  try {
    frame = JSON.parse(line);
    if (frame.id === undefined) continue;
    let result;
    if (frame.method === 'initialize') result = { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cyberdeck-worker-reporting', version: '1' } };
    else if (frame.method === 'tools/list') result = { tools: Object.keys(kinds).map(name => ({ name, description: 'Report this worker activity using a stable eventId; no operator/controller authority.', inputSchema: {
      type: 'object', properties: { summary: { type: 'string' }, eventId: { type: 'string' }, checkpointCorrelationId: { type: 'string' } }, required: ['summary', 'eventId'], additionalProperties: false,
    } })) };
    else if (frame.method === 'tools/call' && Object.hasOwn(kinds, frame.params.name)) result = { content: [{ type: 'text', text: JSON.stringify(await send(frame.params.arguments, frame.params.name)) }] };
    else throw new Error('MCP_METHOD_REFUSED');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
  } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame?.id ?? null, error: { code: -32602, message: 'Worker reporting request refused' } }) + '\n'); }
}
