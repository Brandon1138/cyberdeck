import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "cyberdeck-native-package-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `${command} exited ${result.status}`);
  return result.stdout;
}
try {
  // Build is a prerequisite. Suppress lifecycle hooks so this cannot install or publish.
  const [{ filename }] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]));
  run("tar", ["-xzf", join(directory, filename), "-C", directory]);
  const binary = join(directory, `package/dist/native/bin/${process.platform}-${process.arch}/cyberdeck-core`);
  const output = run(binary, ["instruction-replay-v1"], { input: "" });
  if (output !== '{"protocol":1,"schema":"instruction-v1"}\n{"end":true,"records":0}\n') throw new Error("Packed worker protocol mismatch");
  console.log("Packed host-native worker executes the versioned replay protocol");
} finally { await rm(directory, { recursive: true, force: true }); }
