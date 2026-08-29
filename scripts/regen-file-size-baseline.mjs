import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "src");
const baselinePath = resolve(repositoryRoot, "docs/architecture/file-size-baseline.json");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

function sourcePath(path) {
  return `src/${relative(sourceRoot, path).split(sep).join("/")}`;
}

function lineCount(path) {
  return readFileSync(path, "utf8").split("\n").length - 1;
}

const files = sourceFiles(sourceRoot)
  .map((path) => ({ path: sourcePath(path), maxLines: lineCount(path) }))
  .filter((entry) => entry.maxLines > 500);

writeFileSync(baselinePath, `${JSON.stringify({ files }, null, 2)}\n`, "utf8");
