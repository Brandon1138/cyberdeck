import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
/** Clean packed-CLI proof: pack, assert no evaluation files, install into a fresh prefix, run it.
 * Never aims the installed CLI at the active broker socket. */
const root = await mkdtemp(join(tmpdir(), "cyberdeck-pack-proof-"));
const version = JSON.parse(await readFile("package.json", "utf8")).version as string;
const packed = JSON.parse((await exec("pnpm", ["pack", "--json", "--pack-destination", root], { maxBuffer: 8 * 1024 ** 2 })).stdout) as { filename: string; integrity: string; files?: unknown[] };
const tarball = join(root, packed.filename.split("/").at(-1)!);
const entries = (await exec("tar", ["-tzf", tarball], { maxBuffer: 64 * 1024 ** 2 })).stdout.trim().split("\n");
const evalsExcluded = !entries.some((entry) => entry.includes("/evals/") || entry.includes("/tests/") || entry.includes("/scripts/"));
const prefix = join(root, "install");
await exec("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", tarball], { maxBuffer: 16 * 1024 ** 2, timeout: 600_000 });
const cli = join(prefix, "node_modules", ".bin", "cyberdeck");
const reported = (await exec(cli, ["--version"], { timeout: 30_000 })).stdout.trim();
const result = { version, reported, package: packed.filename.split("/").at(-1), integrity: packed.integrity, files: entries.length, evalsExcluded, installPrefix: prefix };
await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ evidence: root, ...result }));
if (!evalsExcluded || !reported.includes(version)) process.exitCode = 1;
