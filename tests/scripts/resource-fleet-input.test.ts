import { it, expect } from "vitest";
import { mkdtemp, writeFile, symlink, rm, readFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readPrivateInput } from "../../scripts/resource-fleet/private-input.js";
import { runCollector } from "../../scripts/prove-resource-fleet.js";
it("rejects oversized, public, symlink and relative inputs", async () => {
  const dir = await mkdtemp("/private/tmp/cyberdeck-resource-input-");
  try {
    const file = join(dir, "private"); await writeFile(file, "12345", { mode: 0o600 });
    expect((await readPrivateInput(file, 5)).toString()).toBe("12345");
    await expect(readPrivateInput(file, 4)).rejects.toThrow();
    const publicFile = join(dir, "public"); await writeFile(publicFile, "x", { mode: 0o644 });
    await expect(readPrivateInput(publicFile, 10)).rejects.toThrow();
    await symlink(file, join(dir, "link")); await expect(readPrivateInput(join(dir, "link"), 10)).rejects.toThrow();
    await expect(readPrivateInput("relative", 10)).rejects.toThrow();
    await expect(readPrivateInput(dir, 10)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("retains sanitized durable failure after output creation and socket rejection", async () => {
  const dir = await mkdtemp("/private/tmp/cyberdeck-resource-input-");
  const output = "/private/tmp/cyberdeck-resource-output-" + randomUUID();
  try {
    const bytes = "private-config-content"; const hash = createHash("sha256").update(bytes).digest("hex");
    const pinFile = join(dir, "pin"); await writeFile(pinFile, bytes, { mode: 0o600 });
    const choice = { provider: "codex", model: "explicit", effort: "high", authMode: "subscription" };
    const config = { candidate: { sourceSha: "a".repeat(40), dirty: false, configSha256: hash, profileSha256: hash, imageDigest: "sha256:" + "d".repeat(64) },
      brokerId: randomUUID(), installationId: randomUUID(), socket: "/private/tmp/cd-resource-" + randomUUID() + ".sock",
      configFile: pinFile, profileFile: pinFile, workers: Array.from({ length: 8 }, (_, i) => ({ ...choice, provider: i % 2 ? "codex" : "claude" })),
      orchestrator: { ...choice, runtime: "first-party-codex" }, timeoutMs: 100, sampleIntervalMs: 100 };
    const configFile = join(dir, "input"); await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    await runCollector([configFile, output], () => ({ actualSha: "a".repeat(40), dirty: false }));
    const failure = JSON.parse(await readFile(join(output, "failure.json"), "utf8"));
    expect(failure).toEqual({ status: "unverified", launches: 0, stage: "isolated-socket", reason: "collector-input-or-preflight-unavailable" });
    expect((await stat(join(output, "failure.json"))).mode & 0o777).toBe(0o600);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});
