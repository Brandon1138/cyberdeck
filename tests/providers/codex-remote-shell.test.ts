import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("interactive Codex RC routing", () => {
  it("routes launch/resume/fork but leaves tools, workers, and explicit connections under native control", () => {
    const cases = [
      [[], true], [["-m", "gpt-6.1-sol", "work on this"], true],
      [["resume", "--last"], true], [["fork", "thread-id"], true],
      [["exec", "work on this"], false], [["review"], false],
      [["--help"], false], [["resume", "--help"], false],
      [["--version"], false], [["app-server", "daemon", "restart"], false],
      [["remote-control", "pair"], false], [["--remote", "unix:///custom.sock"], false],
      [["plugin", "list"], false], [["doctor"], false], [["update"], false],
      [["--profile", "custom"], false], [["--oss"], false],
      [["--remote=unix:///custom.sock"], false], [["--no-daemon"], false],
      [["-m", "review", "resume", "--last"], true],
      [["--", "--help"], true],
    ] as const;
    const script = `import { interactiveInvocation } from './scripts/codex-remote.mjs';
      const cases = ${JSON.stringify(cases)};
      console.log(JSON.stringify(cases.map(([args]) => interactiveInvocation(args))));`;
    // The launcher imports its built home module, while this verifies routing without starting Codex.
    const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(actual).toEqual(cases.map(([, expected]) => expected));
  });

  it("routes native remote-control administration to the dedicated owner", () => {
    const cases = [
      [["remote-control", "start"], true], [["remote-control", "stop"], true],
      [["-c", 'model="gpt-6.1-sol"', "remote-control", "status"], true],
      [["remote-control", "pair", "--json"], true],
      [["exec", "remote-control start"], false], [["--", "remote-control"], false],
      [["--profile", "custom", "remote-control", "start"], false],
      [["--remote", "unix:///custom.sock", "remote-control", "start"], false],
    ] as const;
    const script = `import { dedicatedRemoteControlInvocation } from './scripts/codex-remote.mjs';
      console.log(JSON.stringify(${JSON.stringify(cases)}.map(([args]) => dedicatedRemoteControlInvocation(args))));`;
    const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(actual).toEqual(cases.map(([, expected]) => expected));
  });

  it("keeps workers and noninteractive shells on native Codex", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-shell-routing-"));
    try {
      writeFileSync(join(directory, "codex"), '#!/bin/sh\nprintf "native:%s\\n" "$*"\n', { mode: 0o700 });
      writeFileSync(join(directory, "node"), '#!/bin/sh\nprintf "launcher:%s\\n" "$*"\n', { mode: 0o700 });
      const command = `source '${resolve("scripts/codex-remote-shell.zsh")}'; codex resume --last`;
      const run = (interactive: boolean, role?: string) => execFileSync("/bin/zsh", [
        interactive ? "-dfi" : "-df", "-c", command,
      ], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CYBERDECK_PROCESS_ROLE: role ?? "" } });
      expect(run(false)).toBe("native:resume --last\n");
      expect(run(true, "worker")).toBe("native:resume --last\n");
      expect(run(true)).toContain("codex-remote.mjs run -- resume --last\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
