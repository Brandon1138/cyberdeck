import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
  throw new Error(`Native core does not support ${process.platform}-${process.arch}`);
}
const build = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(root, "native/core/Cargo.toml"), "--target-dir", join(root, "native/core/target")], { stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
for (const base of ["native/bin", "dist/native/bin"]) {
  const target = join(root, base, `${process.platform}-${process.arch}`);
  mkdirSync(target, { recursive: true });
  const binary = join(target, "cyberdeck-core");
  copyFileSync(join(root, "native/core/target/release/cyberdeck-core"), binary);
  chmodSync(binary, 0o755);
}
