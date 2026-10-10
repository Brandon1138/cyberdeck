import { open } from "node:fs/promises";

/** Stream only newline-committed records. An unterminated final write is never authority. */
export async function* completeJsonlLines(path: string): AsyncGenerator<string> {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (file === undefined) return;
  try {
    const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    let fragments: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        let start = 0;
        let newline: number;
        while ((newline = buffer.indexOf(10, start)) !== -1) {
          fragments.push(buffer.subarray(start, newline));
          yield Buffer.concat(fragments).toString("utf8");
          fragments = [];
          start = newline + 1;
        }
        if (start < buffer.length) fragments.push(buffer.subarray(start));
      }
    } finally { stream.destroy(); }
  } finally { await file.close(); }
}
