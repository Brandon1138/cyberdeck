import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ForbiddenProbeError,
  OBSERVED_PROBE_SIDE_EFFECTS,
  PROVIDER_PROBES,
  UNVERIFIED_RUNTIME_CAPABILITIES,
  assertReadOnlyProbe,
  runCapabilityProbe,
  summarizeAdvertisedFlags,
  type CapabilityProbeSpec,
} from "../../scripts/probe-provider-capabilities.js";

function spec(overrides: Partial<CapabilityProbeSpec> = {}): CapabilityProbeSpec {
  return {
    id: "test.probe",
    provider: "claude",
    executable: "claude",
    args: ["--version"],
    kind: "version",
    documentedBy: "test",
    ...overrides,
  };
}

describe("PROVIDER_PROBES", () => {
  it("only targets the three recorded provider executables", () => {
    const executables = new Set(PROVIDER_PROBES.map((probe) => probe.executable));
    expect([...executables].sort()).toEqual(["agent", "agy", "claude"]);
  });

  it("passes its own read-only assertion for every entry", () => {
    for (const probe of PROVIDER_PROBES) {
      expect(() => assertReadOnlyProbe(probe), probe.id).not.toThrow();
    }
  });

  it("records command provenance for every entry", () => {
    for (const probe of PROVIDER_PROBES) {
      expect(probe.documentedBy, probe.id).not.toBe("");
      expect(probe.args.length, probe.id).toBeGreaterThan(0);
    }
  });

  it("uses unique ids", () => {
    const ids = PROVIDER_PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("assertReadOnlyProbe", () => {
  it("rejects an empty argv because a bare provider command starts an interactive session", () => {
    expect(() => assertReadOnlyProbe(spec({ args: [] }))).toThrow(ForbiddenProbeError);
  });

  it.each([
    ["claude print", ["-p", "hello"]],
    ["claude long print", ["--print", "hello"]],
    ["claude bare prompt operand", ["explain this repository"]],
    ["claude model selection", ["--model", "claude-fable-5"]],
    ["claude fable alias", ["--model", "fable"]],
    ["claude continue", ["--continue"]],
    ["claude resume", ["--resume"]],
    ["claude background", ["--bg"]],
    ["claude remote control", ["--remote-control"]],
    ["claude skip permissions", ["--dangerously-skip-permissions"]],
    ["claude auth login", ["auth", "login"]],
    ["claude auth logout", ["auth", "logout"]],
    ["claude setup token", ["setup-token"]],
    ["claude install", ["install"]],
    ["claude update", ["update"]],
    ["cursor print", ["-p"]],
    ["cursor output format", ["--print", "--output-format", "json"]],
    ["cursor mode", ["--mode", "plan"]],
    ["cursor login", ["login"]],
    ["cursor logout", ["logout"]],
    ["cursor update", ["update"]],
    ["cursor worker", ["worker"]],
    ["cursor shell integration", ["install-shell-integration"]],
    ["cursor create chat", ["create-chat"]],
    ["antigravity print", ["--print", "hello"]],
    ["antigravity prompt", ["--prompt", "hello"]],
    ["antigravity interactive prompt", ["--prompt-interactive", "hello"]],
    ["antigravity short interactive", ["-i", "hello"]],
    ["antigravity continue", ["-c"]],
    ["antigravity install", ["install"]],
    ["antigravity update", ["update"]],
    ["antigravity new project", ["--new-project"]],
  ] as const)("rejects %s", (_label, args) => {
    expect(() => assertReadOnlyProbe(spec({ args: [...args] }))).toThrow(ForbiddenProbeError);
  });

  it.each([
    ["version", ["--version"]],
    ["help", ["--help"]],
    ["claude auth status", ["auth", "status"]],
    ["cursor status", ["status"]],
    ["cursor models", ["models"]],
    ["antigravity agents", ["agents"]],
  ] as const)("allows the read-only shape %s", (_label, args) => {
    expect(() => assertReadOnlyProbe(spec({ args: [...args] }))).not.toThrow();
  });
});

describe("runCapabilityProbe", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cyberdeck-probe-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("refuses to spawn a forbidden probe and starts no process at all", async () => {
    const sentinel = join(workDir, "spawned.txt");
    const forbidden = spec({
      executable: process.execPath,
      args: ["--print", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'spawned')`],
    });

    await expect(runCapabilityProbe(forbidden)).rejects.toThrow(ForbiddenProbeError);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("reports a missing executable without throwing", async () => {
    const result = await runCapabilityProbe(
      spec({ executable: "cyberdeck-provider-that-does-not-exist" }),
    );
    expect(result.status).toBe("missing");
    expect(result.evidenceKind).toBe("observed-now");
    expect(result.stdout).toBe("");
  });

  it("captures exact command provenance and separated streams", async () => {
    const result = await runCapabilityProbe(
      spec({ executable: process.execPath, args: ["--version"] }),
    );
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.command.executable).toBe(process.execPath);
    expect(result.command.args).toEqual(["--version"]);
    expect(result.stdout).toMatch(/^v\d+/);
    expect(result.stderr).toBe("");
  });
});

describe("summarizeAdvertisedFlags", () => {
  it("marks help text as advertised but never as live-verified", () => {
    const help = "Options:\n  --print  Print response and exit\n  --model <model>  Model\n";
    const summary = summarizeAdvertisedFlags(help, ["--print", "--model", "--nonexistent"]);

    expect(summary).toEqual([
      { flag: "--print", advertised: true, verifiedLive: false },
      { flag: "--model", advertised: true, verifiedLive: false },
      { flag: "--nonexistent", advertised: false, verifiedLive: false },
    ]);
  });

  it("never returns a verified live capability for any input", () => {
    const summary = summarizeAdvertisedFlags("--anything", ["--anything"]);
    expect(summary.every((entry) => entry.verifiedLive === false)).toBe(true);
  });
});

describe("OBSERVED_PROBE_SIDE_EFFECTS", () => {
  it("keeps the antigravity self-update observation on the record with evidence", () => {
    const antigravity = OBSERVED_PROBE_SIDE_EFFECTS.filter(
      (entry) => entry.provider === "antigravity",
    );
    expect(antigravity.length).toBeGreaterThan(0);
    for (const entry of antigravity) {
      expect(entry.evidence).not.toBe("");
      expect(entry.mitigation).not.toBe("");
    }
  });
});

describe("UNVERIFIED_RUNTIME_CAPABILITIES", () => {
  it("records every capability that would need a live session, with a reason", () => {
    expect(UNVERIFIED_RUNTIME_CAPABILITIES.length).toBeGreaterThan(0);
    for (const entry of UNVERIFIED_RUNTIME_CAPABILITIES) {
      expect(entry.reason).not.toBe("");
      expect(entry.evidenceKind).toBe("unverified-runtime");
    }
  });
});
