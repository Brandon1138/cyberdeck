import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { sentryOutageScenario } from "../../evals/harness/turn-scenarios.js";

it("waits for durable settlement activity after the instruction becomes completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-sink-"));
  const append = AgentActivityStore.prototype.append;
  const delayed = vi.spyOn(AgentActivityStore.prototype, "append").mockImplementation(async function (this: AgentActivityStore, input) {
    if (input.kind === "instruction.settled") await new Promise((resolve) => setTimeout(resolve, 150));
    return append.call(this, input);
  });
  try {
    const result = await sentryOutageScenario(root);
    expect(result.checks).toEqual({
      "delivery-with-failing-sink": true,
      "local-evidence-durable": true,
      "settlement-with-failing-sink": true,
    });
  } finally { delayed.mockRestore(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
