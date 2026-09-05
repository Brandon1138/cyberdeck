import { openContainedSource } from "./contained-source.js";

/** Byte offsets refer only to complete frames. No readline buffering of unbounded worker input. */
export async function* nativeSourceLines(root: string, path: string): AsyncGenerator<{ offset: number; end: number; text: string }> {
  const file = await openContainedSource(root, path);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error("ACTIVITY_SOURCE_LIMIT");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0, offset = 0, partial = Buffer.alloc(0);
    while (position < stat.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) throw new Error("ACTIVITY_SOURCE_TRUNCATED");
      position += bytesRead;
      partial = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = partial.indexOf(10)) >= 0) {
        if (newline > 1024 * 1024) throw new Error("ACTIVITY_SOURCE_FRAME_LIMIT");
        const end = offset + newline + 1;
        yield { offset, end, text: partial.subarray(0, newline).toString("utf8") };
        offset = end; partial = partial.subarray(newline + 1);
      }
      if (partial.length > 1024 * 1024) throw new Error("ACTIVITY_SOURCE_FRAME_LIMIT");
    }
  } finally { await file.close(); }
}
