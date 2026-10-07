import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JsonlOffsetReader } from "../../src/persistence/jsonl-offset-reader.js";

it("reads only complete appended lines and resets on replacement, truncation, disappearance and rebind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-native-offset-"));
  try {
    const path = join(directory, "native.jsonl"), other = join(directory, "other.jsonl");
    const lines: string[] = [];
    const reader = new JsonlOffsetReader(() => { lines.length = 0; });
    await writeFile(path, 'one\n漢');
    await reader.scan(path, (line) => lines.push(line));
    expect(lines).toEqual(["one"]); expect(reader.offset).toBe(4);
    await reader.scan(path, (line) => lines.push(line));
    expect(lines).toEqual(["one"]);
    await appendFile(path, '字\ntwo\n');
    await reader.scan(path, (line) => lines.push(line));
    expect(lines).toEqual(["one", "漢字", "two"]);
    await writeFile(other, 'replacement bigger than old file\n');
    await rename(other, path);
    await reader.scan(path, (line) => lines.push(line));
    expect(lines).toEqual(["replacement bigger than old file"]);
    await writeFile(path, 'short\n');
    await reader.scan(path, (line) => lines.push(line));
    expect(lines).toEqual(["short"]);
    await writeFile(other, 'rebound\n');
    await reader.scan(other, (line) => lines.push(line));
    expect(lines).toEqual(["rebound"]);
    await rm(other);
    await reader.scan(other, (line) => lines.push(line));
    expect(lines).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
