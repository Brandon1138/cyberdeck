import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShellCommand } from "../../src/runtime/shell-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-shell-command-test-"));
  temporaryDirectories.push(path);
  return realpath(path);
}

function run(command: string, cwd: string) {
  let output = "";
  return runShellCommand({
    command,
    cwd,
    shell: "/bin/zsh",
    onOutput: (chunk) => { output += chunk; },
  }).then((result) => ({ ...result, output }));
}

describe("shell command", () => {
  it("runs the operator's line with no allowlist between it and the shell", async () => {
    const root = await temporaryDirectory();
    await expect(run("printf 'hello %s' world", root)).resolves.toMatchObject({
      exitStatus: 0,
      cwd: root,
      output: "hello world",
    });
    // Pipes, substitutions, redirects and chains are the point of the mode, not something to catch.
    await expect(run("printf 'a\\nb\\n' | grep b && echo $((2 + 3))", root)).resolves.toMatchObject({
      exitStatus: 0,
      output: "b\n5\n",
    });
  });

  it("reports where the shell ended up so cd persists into the next line", async () => {
    const root = await temporaryDirectory();
    const child = join(root, "child");
    await run("mkdir child", root);
    const moved = await run("cd child", root);
    expect(moved.cwd).toBe(child);
    // The next line runs where the last one left off, which is the whole mechanism.
    await expect(run("pwd", moved.cwd!)).resolves.toMatchObject({ output: `${child}\n` });
  });

  it("is not fooled by output that looks like its own sentinel", async () => {
    const root = await temporaryDirectory();
    // A fixed marker would be forgeable; this line prints a plausible one and a plausible payload.
    const forged = "0".repeat(64);
    const result = await run(
      `printf '\\n%s\\n0\\n/nowhere-at-all\\n' '${forged}'; printf 'real output\\n'`,
      root,
    );
    expect(result.cwd).toBe(root);
    expect(result.output).toContain(forged);
    expect(result.output).toContain("real output");
  });

  it("keeps a non-zero status and passes stderr through", async () => {
    const root = await temporaryDirectory();
    const failed = await run("printf 'nope\\n' >&2; false", root);
    expect(failed.exitStatus).toBe(1);
    expect(failed.output).toContain("nope");
    expect(failed.cwd).toBe(root);
    await expect(run("cyberdeck-no-such-command", root)).resolves.toMatchObject({
      exitStatus: 127,
    });
    // A line that ends the shell itself carries its status out through the process.
    expect((await run("exit 3", root)).exitStatus).toBe(3);
  });

  it("leaves the cwd alone when the shell never reports one", async () => {
    const root = await temporaryDirectory();
    // `exec` replaces the shell, so nothing runs after the operator's line.
    const replaced = await run("exec printf 'gone\\n'", root);
    expect(replaced).toMatchObject({ exitStatus: 0, output: "gone\n" });
    expect(replaced.cwd).toBeUndefined();
  });

  it("streams output as it arrives rather than at the end", async () => {
    const root = await temporaryDirectory();
    const chunks: string[] = [];
    const finished = runShellCommand({
      command: "printf 'first\\n'; sleep 0.4; printf 'second\\n'",
      cwd: root,
      shell: "/bin/zsh",
      onOutput: (chunk) => { chunks.push(chunk); },
    });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    // The trailing newline is held back, because a newline is how the sentinel begins.
    expect(chunks.join("")).toBe("first");
    await finished;
    expect(chunks.join("")).toBe("first\nsecond\n");
  });
});
