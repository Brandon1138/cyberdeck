import { readFileSync } from "node:fs";

const packageJsonUrl = new URL(
  import.meta.url.endsWith(".ts") ? "../package.json" : "../../package.json",
  import.meta.url,
);
const packageMetadata = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json must declare a non-empty version");
}

export const CYBERDECK_VERSION = packageMetadata.version;
