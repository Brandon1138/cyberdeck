#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function assertDisposableHost(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Packed broker acceptance requires a disposable GitHub-hosted CI runner; never run it on an operator host");
  }
  if (!environment.RUNNER_TEMP || !environment.RUNNER_TEMP.startsWith("/")) {
    throw new Error("Packed acceptance requires an absolute RUNNER_TEMP");
  }
}

export function inspectPackedFiles(files) {
  const names = new Set(files);
  for (const required of ["package.json", "LICENSE", "README.md", "docs/linux-install.md", "dist/src/cli.js", "dist/src/broker/main.js"]) {
    assert(names.has(required), `Packed artifact is missing ${required}`);
  }
  const forbidden = files.find((name) => name === "nvim.log" || /^(?:tests\/|scripts\/|evals\/|dist\/(?:tests|scripts|evals)\/|docs\/prompts\/)/u.test(name));
  assert(!forbidden, `Packed artifact contains development-only file ${forbidden}`);
  const modules = files.filter((name) => name.endsWith("/lua/cyberdeck/init.lua"));
  assert.equal(modules.length, 1, "Packed artifact must contain exactly one Cyberdeck Lua module (integrate the nvim packaging patch)");
  return modules[0];
}

export function assertFreshBrokerPaths(paths) {
  for (const [kind, path] of [["state", paths.appStateDirectory], ["socket", paths.brokerSocketPath]]) {
    try { lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error(`Refusing existing broker ${kind}: ${path}`);
  }
}

function run(command, args, environment, cwd, timeout = 120_000) {
  const result = spawnSync(command, args, { env: environment, cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 ** 2 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}: ${result.error?.message ?? `exit ${result.status}`}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

export async function verifyInstalledPty(packageRoot, environment, cwd) {
  const require = createRequire(join(packageRoot, "package.json"));
  const ptyRoot = dirname(require.resolve("node-pty/package.json"));
  if (process.env.CYBERDECK_NATIVE_BUILD_FROM_SOURCE === "1") {
    assert(existsSync(join(ptyRoot, "build/Release/pty.node")), "Forced compiler fallback did not produce pty.node");
    assert(!existsSync(join(ptyRoot, "prebuilds")), "Forced compiler fallback left prebuilds available");
  }
  const pty = require("node-pty");
  for (const shell of ["bash", "zsh"]) {
    await new Promise((fulfill, reject) => {
      const child = pty.spawn(shell, ["-f", "-c", "read -r line; printf 'cyberdeck-installed-pty:%s\\n' \"$line\""], {
        name: "xterm-256color", cols: 80, rows: 24, cwd, env: environment,
      });
      let output = "";
      const deadline = setTimeout(() => {
        try { child.kill(); } catch { /* The timed-out child may have just exited. */ }
        reject(new Error(`Installed ${shell} PTY timed out`));
      }, 10_000);
      child.onData((data) => { output += data; });
      child.onExit(({ exitCode }) => {
        clearTimeout(deadline);
        if (exitCode !== 0 || !output.includes("cyberdeck-installed-pty:acceptance")) {
          reject(new Error(`Installed ${shell} PTY failed: exit ${exitCode}, output ${JSON.stringify(output)}`));
        } else fulfill();
      });
      child.write("acceptance\r");
    });
  }
  console.log("Installed node-pty passed real Bash and zsh input/output");
}

async function verifyInstalledLua(packageRoot, modulePath, environment, root) {
  const worktree = join(root, "lua-worktree");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "proof.txt"), "packed Lua proof\n");
  const { remoteExprArgs } = await import(pathToFileURL(join(packageRoot, "dist/src/nvim/bridge.js")));
  const { encodeNvimPayload } = await import(pathToFileURL(join(packageRoot, "dist/src/nvim/quickfix.js")));
  const request = { session: "packed-proof", worktree, title: "Packed acceptance", live: true, entries: [{ filename: join(worktree, "proof.txt"), lnum: 1, col: 1, text: "proof" }] };
  const expression = (entryPoint, live) => remoteExprArgs("/unused", entryPoint, encodeNvimPayload({ ...request, live }))[3];
  const script = join(root, "packed-lua.lua");
  writeFileSync(script, `
package.path = os.getenv("CYBERDECK_TEST_LUA_ROOT") .. "/?.lua;" .. os.getenv("CYBERDECK_TEST_LUA_ROOT") .. "/?/init.lua;" .. package.path
local cyberdeck = require("cyberdeck")
local file = os.getenv("CYBERDECK_TEST_WORKTREE") .. "/proof.txt"
assert(vim.fn.eval(os.getenv("CYBERDECK_TEST_OPEN_EXPR")) == "ok:1")
vim.cmd("edit " .. vim.fn.fnameescape(file))
assert(vim.bo.modifiable == false, "packaged module did not lock live buffer")
local version = cyberdeck.protocol_version
cyberdeck.protocol_version = version + 1
assert(vim.fn.eval(os.getenv("CYBERDECK_TEST_REFRESH_EXPR")):match("protocol mismatch"), "packaged RPC accepted a mismatched module")
assert(vim.bo.modifiable == false, "rejected refresh released the live buffer")
cyberdeck.protocol_version = version
assert(vim.fn.eval(os.getenv("CYBERDECK_TEST_REFRESH_EXPR")) == "ok:1")
assert(vim.bo.modifiable == true, "packaged module did not release completed buffer")
io.write("cyberdeck-installed-lua:ok\\n")
`);
  const output = run("nvim", ["--headless", "-u", "NONE", "-i", "NONE", "-l", script], {
    ...environment, CYBERDECK_TEST_LUA_ROOT: dirname(dirname(join(packageRoot, modulePath))), CYBERDECK_TEST_WORKTREE: worktree,
    CYBERDECK_TEST_OPEN_EXPR: expression("open", true), CYBERDECK_TEST_REFRESH_EXPR: expression("refresh", false),
  }, root, 30_000);
  assert(output.includes("cyberdeck-installed-lua:ok"), "Installed Lua acceptance marker is missing");
  console.log("Installed Lua module passed real Neovim lock/release");
}

export async function packedAcceptance(artifact) {
  // Check before npm, filesystem state discovery, or any broker lifecycle command.
  assertDisposableHost();
  assert.equal(process.version, "v24.18.0");
  if (process.env.CYBERDECK_NATIVE_EXPECT_ARCH) assert.equal(process.arch, process.env.CYBERDECK_NATIVE_EXPECT_ARCH);
  const root = mkdtempSync(join(process.env.RUNNER_TEMP, "cyberdeck-native-"));
  const environment = {
    PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash",
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
    XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    ...(process.env.CYBERDECK_NATIVE_BUILD_FROM_SOURCE === "1" ? { npm_config_build_from_source: "true" } : {}),
  };
  for (const directory of [environment.XDG_RUNTIME_DIR, environment.TMPDIR]) mkdirSync(directory, { mode: 0o700 });
  const prefix = join(root, "installed");
  const cli = join(prefix, "bin/cyberdeck");
  let started = false;
  let report = { platform: process.platform, architecture: process.arch, node: process.version, sourceBuild: process.env.CYBERDECK_NATIVE_BUILD_FROM_SOURCE === "1", passed: false };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `evidence-root=${root}\n`);
  try {
    let packageFile;
    let files;
    if (artifact) {
      packageFile = resolve(artifact);
      files = run("tar", ["-tzf", packageFile], environment, root).trim().split("\n").filter((name) => !name.endsWith("/")).map((name) => name.replace(/^package\//u, ""));
    } else {
      const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--silent", "--pack-destination", root], environment, process.cwd()));
      packageFile = join(root, packed.filename);
      files = packed.files.map(({ path }) => path);
    }
    const modulePath = inspectPackedFiles(files);
    const metadata = JSON.parse(run("tar", ["-xOzf", packageFile, "package/package.json"], environment, root));
    assert.equal(metadata.name, "@ishmael38/cyberdeck");
    assert.equal(metadata.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `package-file=${packageFile}\n`);
    process.stdout.write(run("npm", ["install", "--global", "--prefix", prefix, "--foreground-scripts", "--no-audit", "--no-fund", packageFile], environment, root, 600_000));
    assert.equal(run(cli, ["--version"], environment, root).trim(), metadata.version);
    assert(run(cli, ["--help"], environment, root).includes("broker"));
    const packageRoot = join(prefix, "lib/node_modules/@ishmael38/cyberdeck");
    await verifyInstalledPty(packageRoot, environment, root);
    await verifyInstalledLua(packageRoot, modulePath, environment, root);
    const { resolveAppPaths } = await import(pathToFileURL(join(packageRoot, "dist/src/broker/app-paths.js")));
    // Homedir stays native, including macOS's unchanged Application Support location.
    const { homedir } = await import("node:os");
    const paths = resolveAppPaths({ platform: process.platform, homeDirectory: homedir(), environment, uid: process.getuid() });
    assertFreshBrokerPaths(paths);
    started = true;
    process.stdout.write(run(cli, ["broker", "start"], environment, root));
    const status = run(cli, ["broker", "status"], environment, root);
    const brokerStatus = JSON.parse(status);
    assert.equal(brokerStatus.healthy, true, "Installed broker is unhealthy");
    assert(Number.isInteger(brokerStatus.pid) && brokerStatus.pid > 0, "Installed broker returned no process identity");
    assert.equal(brokerStatus.workers.activeWorkers, 0, "Fresh broker unexpectedly has active workers");
    writeFileSync(join(root, "broker-status.json"), status);
    process.stdout.write(status);
    process.stdout.write(run(cli, ["broker", "stop"], environment, root));
    const { waitForBrokerStop } = await import(pathToFileURL(join(packageRoot, "dist/src/cli/broker-process.js")));
    await waitForBrokerStop();
    started = false;
    if (existsSync(join(paths.appStateDirectory, "broker.log"))) writeFileSync(join(root, "broker.log"), readFileSync(join(paths.appStateDirectory, "broker.log")));
    report = { ...report, version: metadata.version, packageFile, luaModule: modulePath, passed: true };
    console.log(`Packed acceptance passed: ${process.platform}/${process.arch}; evidence ${root}`);
  } catch (error) {
    report = { ...report, error: error.message };
    throw error;
  } finally {
    if (started) {
      try { process.stdout.write(run(cli, ["broker", "stop"], environment, root, 15_000)); }
      catch (error) { console.error(`Disposable broker cleanup failed: ${error.message}`); }
    }
    writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await packedAcceptance(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
