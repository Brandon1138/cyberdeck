import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";

export const nativeInstructionBinary = fileURLToPath(new URL(
  `../../native/bin/${process.platform}-${process.arch}/cyberdeck-core`, import.meta.url,
));

interface NativeReplayOptions { binary?: string; timeoutMs?: number; maxOutputBytes?: number }

/** A cold-replay worker, never a second journal writer. Success requires both a
 * complete versioned stream and exit zero; no partial projection can escape. */
export async function replayInstructionsNative(file: FileHandle, options: NativeReplayOptions = {}): Promise<Map<string, InstructionRecord>> {
  const child = spawn(options.binary ?? nativeInstructionBinary, ["instruction-replay-v1"], { stdio: ["pipe", "pipe", "pipe"] });
  // FileHandle streams close their descriptor on destroy even with autoClose:false.
  // Borrow it through positional reads so cancellation cannot steal the host's
  // descriptor before its mandatory post-replay identity check.
  const input = Readable.from(readChunks(file), { objectMode: false, highWaterMark: 64 * 1024 });
  const records = new Map<string, InstructionRecord>();
  let header = false, ended = false, inputEnded = false, received = 0;
  let buffer: Buffer = Buffer.alloc(0);
  const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024 * 1024;
  let failure: Error | undefined;
  let diagnostic = "";
  child.stderr.on("data", (bytes: Buffer) => {
    if (diagnostic.length < 4096) diagnostic += bytes.subarray(0, 4096 - diagnostic.length).toString("utf8");
  });
  const fail = (error: Error) => { failure ??= error; input.destroy(); child.stdin.destroy(); child.kill("SIGKILL"); };
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => { fail(new Error("Cannot start Rust instruction replay; run pnpm build:native for this host or select CYBERDECK_INSTRUCTION_REPLAY=typescript", { cause: error })); });
    child.once("close", (code) => {
      input.destroy();
      if (failure !== undefined) reject(failure);
      else if (code !== 0) reject(new Error(`Native instruction replay exited ${code}${safeDiagnostic(diagnostic)}; no projection was published`));
      else resolve();
    });
  });
  // Attach immediately: a fast spawn failure must not become an unhandled rejection.
  void exit.catch(() => {});
  input.once("error", (error) => fail(error));
  input.once("end", () => { inputEnded = true; });
  child.stdin.once("error", (error) => fail(error));
  const timer = setTimeout(() => fail(new Error("Native instruction replay timed out")), options.timeoutMs ?? 120_000);
  try {
    input.pipe(child.stdin);
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      received += bytes.length;
      if (received > maxOutputBytes) throw new Error("Native instruction replay output limit exceeded");
      buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > 16 * 1024 * 1024) throw new Error("Native instruction replay record limit exceeded");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!header) {
          if (JSON.stringify(value) !== '{"protocol":1,"schema":"instruction-v1"}') throw new Error("Native instruction replay protocol mismatch");
          header = true;
        } else if (ended) throw new Error("Native instruction replay returned trailing output");
        else if (typeof value === "object" && value !== null && "end" in value) {
          const end = value as { end?: unknown; records?: unknown };
          if (end.end !== true || end.records !== records.size) throw new Error("Native instruction replay count mismatch");
          ended = true;
        } else {
          const record = InstructionRecordSchema.parse(value);
          if (records.has(record.id)) throw new Error("Native instruction replay returned duplicate identities");
          records.set(record.id, record);
        }
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Native instruction replay record limit exceeded");
    }
    await exit;
    if (!inputEnded || !header || !ended || buffer.length !== 0) throw new Error("Native instruction replay returned an incomplete projection");
    return records;
  } catch (error) {
    fail(error instanceof Error ? error : new Error("Native instruction replay failed"));
    await exit.catch(() => {});
    throw failure;
  } finally { clearTimeout(timer); input.destroy(); }
}

function safeDiagnostic(text: string): string {
  try {
    const value = JSON.parse(text) as { protocol?: unknown; error?: unknown; line?: unknown };
    const allowed = ["INPUT_IO", "OUTPUT_IO", "RECORD_LIMIT", "INVALID_UTF8", "INVALID_JSON", "INVALID_RECORD"];
    if (value.protocol === 1 && typeof value.error === "string" && allowed.includes(value.error)
      && typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line >= 0) return ` (${value.error} at line ${value.line})`;
  } catch { /* Arbitrary child diagnostics are never surfaced as journal content. */ }
  return "";
}

async function* readChunks(file: FileHandle): AsyncGenerator<Buffer> {
  let position = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
