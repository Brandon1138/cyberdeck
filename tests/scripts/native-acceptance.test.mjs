import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertDisposableHost, assertFreshBrokerPaths, inspectPackedFiles } from "../../scripts/ci-packed-acceptance.mjs";

const preflight = fileURLToPath(new URL("../../scripts/ci-native-preflight.mjs", import.meta.url));
const acceptance = fileURLToPath(new URL("../../scripts/ci-packed-acceptance.mjs", import.meta.url));
const required = ["package.json", "LICENSE", "README.md", "docs/linux-install.md", "dist/src/cli.js", "dist/src/broker/main.js"];
const modulePath = "contrib/nvim/lua/cyberdeck/init.lua";

function withTools(overrides, check) {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-preflight-test-"));
  try {
    const tools = {
      pnpm: "11.5.0", tmux: "tmux 3.3a", nvim: "NVIM v0.10.0", zsh: "zsh 5.9",
      bash: "GNU bash 5.2", git: "git version 2.43.0", python3: "Python 3.12.3", make: "GNU Make 4.3", "c++": "g++ 13.2.0",
      ...overrides,
    };
    for (const [command, output] of Object.entries(tools)) {
      if (output !== null) writeFileSync(join(directory, command), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
    }
    const result = spawnSync(process.execPath, [preflight], { env: { PATH: directory }, encoding: "utf8", timeout: 10_000 });
    check(result);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("preflight accepts minimum supported tmux and Neovim, including tmux patch suffix", () => {
  withTools({}, (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tmux: tmux 3\.3a/u);
    assert.match(result.stdout, /nvim: NVIM v0\.10\.0/u);
  });
});

for (const command of ["tmux", "nvim", "zsh", "c++"]) {
  test(`preflight fails missing ${command} before native suites can skip`, () => {
    withTools({ [command]: null }, (result) => {
      assert.notEqual(result.status, 0);
      assert(result.stderr.includes(`Native CI requires ${command}:`), result.stderr);
    });
  });
}

for (const [command, version, expected] of [
  ["tmux", "tmux 3.2a", "Native CI requires tmux >=3.3"],
  ["nvim", "NVIM v0.9.5", "Native CI requires Neovim >=0.10"],
  ["pnpm", "11.4.0", "Unexpected pnpm version"],
]) {
  test(`preflight rejects unsupported ${command} version`, () => {
    withTools({ [command]: version }, (result) => {
      assert.notEqual(result.status, 0);
      assert(result.stderr.includes(expected), result.stderr);
    });
  });
}

test("artifact inspection accepts either packaged Lua layout and requires built broker", () => {
  assert.equal(inspectPackedFiles([...required, modulePath]), modulePath);
  const compiledPath = "dist/src/nvim/lua/cyberdeck/init.lua";
  assert.equal(inspectPackedFiles([...required, compiledPath]), compiledPath);
  assert.throws(() => inspectPackedFiles([...required.filter((path) => !path.endsWith("broker/main.js")), modulePath]), /missing dist\/src\/broker\/main\.js/u);
});

test("artifact inspection fails omitted or ambiguous Lua modules", () => {
  assert.throws(() => inspectPackedFiles(required), /exactly one Cyberdeck Lua module/u);
  assert.throws(() => inspectPackedFiles([...required, modulePath, "dist/src/nvim/lua/cyberdeck/init.lua"]), /exactly one Cyberdeck Lua module/u);
});

test("artifact inspection rejects source-only tests, scripts, and evaluations", () => {
  for (const file of ["tests/proof.test.ts", "scripts/proof.mjs", "evals/config.yaml", "dist/evals/proof.js", "dist/tests/proof.js", "docs/prompts/proof.md", "nvim.log"]) {
    assert.throws(() => inspectPackedFiles([...required, modulePath, file]), /development-only/u);
  }
});

test("broker acceptance refuses operator and self-hosted environments", () => {
  for (const environment of [
    {}, { CI: "true" }, { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted", RUNNER_TEMP: "/tmp" },
  ]) assert.throws(() => assertDisposableHost(environment), /disposable GitHub-hosted/u);
  assert.throws(() => assertDisposableHost({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: "relative" }), /absolute RUNNER_TEMP/u);
  assert.doesNotThrow(() => assertDisposableHost({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: "/tmp" }));
});

test("direct acceptance invocation on operator host has no npm, state, or lifecycle side effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-host-guard-test-"));
  try {
    writeFileSync(join(directory, "npm"), `#!/bin/sh\ntouch '${directory}/npm-was-called'\nexit 1\n`, { mode: 0o700 });
    const before = readdirSync(directory);
    const result = spawnSync(process.execPath, [acceptance], { env: { PATH: directory, RUNNER_TEMP: directory }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /never run it on an operator host/u);
    assert.deepEqual(readdirSync(directory), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("broker freshness guard preserves existing state and sockets, including dangling symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-existing-state-test-"));
  const paths = { appStateDirectory: join(directory, "state"), brokerSocketPath: join(directory, "broker.sock") };
  try {
    assert.doesNotThrow(() => assertFreshBrokerPaths(paths));
    writeFileSync(paths.brokerSocketPath, "existing socket sentinel");
    assert.throws(() => assertFreshBrokerPaths(paths), /Refusing existing broker socket/u);
    symlinkSync(join(directory, "missing-state-target"), paths.appStateDirectory);
    assert.throws(() => assertFreshBrokerPaths(paths), /Refusing existing broker state/u);
    assert(lstatSync(paths.appStateDirectory).isSymbolicLink());
    assert(lstatSync(paths.brokerSocketPath).isFile());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
