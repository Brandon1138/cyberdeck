import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface FileSizeCeiling {
  path: string;
  maxLines: number;
}

interface FileSizeBaseline {
  files: FileSizeCeiling[];
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, "src");
const BASELINE_PATH = resolve(REPOSITORY_ROOT, "docs/architecture/file-size-baseline.json");
const DEFAULT_MAX_LINES = 500;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

function sourcePath(path: string): string {
  return `src/${relative(SOURCE_ROOT, path).split(sep).join("/")}`;
}

function lineCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").length - 1;
}

function readBaseline(): FileSizeBaseline {
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("files" in parsed)) {
    throw new Error("File-size baseline must contain a files array");
  }
  const files = (parsed as { files: unknown }).files;
  if (!Array.isArray(files)) throw new Error("File-size baseline files must be an array");
  for (const entry of files) {
    if (
      typeof entry !== "object"
      || entry === null
      || typeof (entry as { path?: unknown }).path !== "string"
      || typeof (entry as { maxLines?: unknown }).maxLines !== "number"
      || !Number.isSafeInteger((entry as { maxLines: number }).maxLines)
      || (entry as { maxLines: number }).maxLines <= DEFAULT_MAX_LINES
    ) {
      throw new Error("File-size baseline entries require a source path and integer ceiling above 500");
    }
  }
  return { files: files as FileSizeCeiling[] };
}

describe("TypeScript file-size ratchet", () => {
  it("keeps baseline sorted, unique, and live", () => {
    const paths = readBaseline().files.map((entry) => entry.path);
    expect(paths).toEqual([...new Set(paths)].sort());
    expect(paths.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)))).toEqual([]);
  });

  it("rejects new monoliths and growth above recorded ceilings", () => {
    const ceilings = new Map(readBaseline().files.map((entry) => [entry.path, entry.maxLines]));
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const source = sourcePath(path);
      const lines = lineCount(path);
      const ceiling = ceilings.get(source) ?? DEFAULT_MAX_LINES;
      return lines > ceiling ? [`${source}: ${lines} lines exceeds ${ceiling}`] : [];
    });
    expect(violations).toEqual([]);
  });
});
