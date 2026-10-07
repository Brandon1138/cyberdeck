import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(root, process.argv[2] ?? "dist", "src/client/assets");
mkdirSync(destination, { recursive: true });
for (const name of ["cyberpunk-prompt.png"]) {
  copyFileSync(new URL(`../src/client/assets/${name}`, import.meta.url), resolve(destination, name));
}
