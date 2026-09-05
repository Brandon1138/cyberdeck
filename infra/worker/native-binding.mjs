import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
// Provider observation only. This file carries no authority and cannot change broker state.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 65536) throw new Error('NATIVE_BINDING_LIMIT');
}
const value = JSON.parse(input);
if (value.cwd !== '/workspace' || !/^[a-f0-9-]{36}$/.test(value.session_id)
  || value.transcript_path !== `/home/worker/.claude/projects/-workspace/${value.session_id}.jsonl`) throw new Error('NATIVE_BINDING_REFUSED');
const path = '/home/worker/cyberdeck-native-binding.json';
const temporary = `${path}.${randomUUID()}.pending`, file = await open(temporary, 'wx', 0o600);
try { await file.writeFile(JSON.stringify({ nativeSessionId: value.session_id, relativePath: `.claude/projects/-workspace/${value.session_id}.jsonl` })); await file.sync(); }
finally { await file.close(); }
await rename(temporary, path);
