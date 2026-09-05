import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const output = (s) => process.stdout.write(s);
output('SCRIPT_READY\n');
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync('commands.jsonl', JSON.stringify({ input: line, observedAt: new Date().toISOString() }) + '\n');
  if (line.startsWith('emit:')) { output(JSON.parse(line.slice(5))); continue; }
  if (line === 'hang') { output('\x1b]0;⠹ fixture\x07\x1b[2JWorking\nesc to interrupt'); continue; }
  if (line === 'oom-fixture') { process.exit(137); }
  output('\x1b]0;⠹ fixture\x07\x1b[2JWorking\nesc to interrupt');
  if (line === 'make scoped change') writeFileSync('answer.txt', 'after\n');
  const report = { changedPaths: line === 'make scoped change' ? ['answer.txt'] : [], message: line };
  appendFileSync('reports.jsonl', JSON.stringify(report) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  output('\x1b[2J' + JSON.stringify(report) + '\n\x1b]0;fixture\x07');
}
