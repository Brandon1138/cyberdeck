import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { successionFixture } from "./strigoi-succession-fixture.js";

const fixtures: Awaited<ReturnType<typeof successionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function fixture() { const f = await successionFixture(); fixtures.push(f); return f; }

describe("Alfred resident launch isolation", () => {
  it("loads the installed content for initial residence and refreshes it on renewal without extra inference", async () => {
    const f = await fixture(), original = f.registry.get(f.original.activeBinding!.sessionId);
    expect(original.providerInstructions).toContain(f.skillContent);
    const updated = "Alfred fixture: updated commitment for the next incarnation.\n";
    await writeFile(f.alfredSkillPath, updated);
    const renewal = await f.runtime.succession!.renew(1, "fixture renewal", "alfred-renewal");
    const state = await f.drive(renewal.id);
    expect(state.transition?.phase).toBe("complete");
    const successor = f.registry.get(state.activeBinding!.sessionId);
    expect(successor.providerInstructions).toContain(updated);
    expect(successor.providerInstructions).not.toContain(f.skillContent);
    expect(successor.providerInstructions).toContain(state.latestPacket!.sha256);
    expect(state.activeBinding!.grant.capabilities).toEqual(f.original.activeBinding!.grant.capabilities);
    expect(f.submitted.map(turn => turn.kind)).toEqual(["checkpoint", "adoption"]);
    expect(f.inference).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled();
  });

  it("does not leak resident instructions to an ordinary worker, Fleet/workspace Orc, or Strigoi-created peer", async () => {
    const f = await fixture();
    const worker = await f.registry.start({ provider: "codex", cwd: f.root, sandbox: "read-only", detached: true, name: "Strigoi" });
    const fleet = await f.runtime.manager.ensure({ provider: "codex", cwd: f.root, scope: "fleet" });
    const workspace = await f.runtime.manager.ensure({ provider: "codex", cwd: f.root, scope: "workspace" });
    const peer = await f.runtime.manager.createPeer({ provider: "codex", model: "gpt-5.6-sol", cwd: f.root, scope: "fleet", name: "Strigoi",
      capabilities: [...f.original.activeBinding!.grant.capabilities],
      createdBy: { sessionId: f.original.activeBinding!.sessionId, depth: 1, mutationId: "fixture-peer",
        approval: { kind: "per-create", channel: "terminal", quote: "fixture-only approval" } } });
    for (const session of [worker, fleet.session, workspace.session, peer.session]) {
      expect(session.providerInstructions ?? "").not.toContain(f.skillContent);
      expect(session.providerInstructions ?? "").not.toContain("Resident skill: Alfred");
      expect(session.providerInstructions ?? "").not.toContain("You are Strigoi");
    }
    expect(peer.binding.kind).toBe("peer");
    expect(peer.binding.createdBy?.sessionId).toBe(f.original.activeBinding!.sessionId);
    expect(peer.binding.grant.capabilities).toEqual(f.original.activeBinding!.grant.capabilities);
  });
});
