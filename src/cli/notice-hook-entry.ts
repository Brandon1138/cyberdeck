import { pathToFileURL } from "node:url";
import { NoticeHookFormatSchema, type NoticeHookFormat } from "../domain/orchestrator-notice-file.js";
import { runNoticeHook } from "./notice-hook.js";

/**
 * The provider hook command, as a process of its own.
 *
 * It runs after every tool call an orchestrator makes, inside a 2-second budget, so it imports
 * only the notice-file reader and the domain module behind it: the full `cyberdeck` program
 * measured 1.3 s to 5 s to start on this host (decision D15). It reads two small files, prints at
 * most one line, and always exits 0; a provider that sees a non-zero exit or a timeout drops the
 * notice, and one that sees an error can show the model the whole command line.
 */
export interface NoticeHookEntryIo {
  argv: readonly string[];
  /** The hook payload the provider writes to stdin, when there is one. */
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  now?: () => string;
}

export interface NoticeHookArguments {
  sessionId: string;
  stateDirectory: string;
  format: NoticeHookFormat;
  event: string;
}

export function parseNoticeHookArguments(argv: readonly string[]): NoticeHookArguments | undefined {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag?.startsWith("--") && value !== undefined && !value.startsWith("--")) {
      values.set(flag.slice(2), value);
      index += 1;
    }
  }
  const sessionId = values.get("actor-session");
  const stateDirectory = values.get("state-directory");
  const format = NoticeHookFormatSchema.safeParse(values.get("format") ?? "claude");
  if (sessionId === undefined || stateDirectory === undefined || !format.success) return undefined;
  return { sessionId, stateDirectory, format: format.data, event: values.get("event") ?? "PostToolUse" };
}

/** Claude re-fires Stop with this flag set; a notice buys one extra turn, never a loop (D16). */
function stopHookAlreadyActive(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as { stop_hook_active?: unknown };
    return parsed.stop_hook_active === true;
  } catch {
    return false;
  }
}

export async function runNoticeHookEntry(io: NoticeHookEntryIo): Promise<void> {
  const parsed = parseNoticeHookArguments(io.argv);
  if (parsed === undefined) return;
  if (parsed.event === "Stop" && stopHookAlreadyActive(await io.stdin().catch(() => ""))) return;
  const output = await runNoticeHook({
    sessionId: parsed.sessionId,
    stateDirectory: parsed.stateDirectory,
    format: parsed.format,
    hookEventName: parsed.event,
    ...(io.now === undefined ? {} : { now: io.now }),
  }).catch(() => undefined);
  if (output !== undefined) io.stdout(`${output}\n`);
}

/** Read stdin to EOF, but never wait on a provider that keeps the pipe open. */
function readStdin(timeoutMs = 500): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const finish = () => {
      clearTimeout(timer);
      resolve(chunks.join(""));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { chunks.push(String(chunk)); });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNoticeHookEntry({
    argv: process.argv.slice(2),
    stdin: readStdin,
    stdout: (text) => process.stdout.write(text),
  }).then(() => process.exit(0), () => process.exit(0));
}
