import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
export async function readPrivateInput(path: string, limit: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("absolute-private-input-required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > limit)
      throw new Error("private-input-invalid");
    const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("private-input-changed");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
