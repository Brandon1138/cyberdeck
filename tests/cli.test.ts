import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { OrchestratorManagerResult } from "../src/orchestration/orchestrator-manager.js";

function quietCommand(name: string) {
  const command = createProgram().commands.find((candidate) => candidate.name() === name)!;
  return command.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
}

function orchestratorResult(created: boolean): OrchestratorManagerResult {
  const now = "2026-07-22T12:00:00.000Z";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const cwd = process.cwd();
  const scope = { kind: "workspace" as const, cwd };
  return {
    created,
    session: {
      id: sessionId,
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd,
      detached: true,
      sandbox: "read-only",
      role: "orchestrator",
      kind: "orchestrator",
      providerInstructions: "guidance",
      createdAt: now,
      updatedAt: now,
      executionState: "active",
      attachmentState: "detached",
      pid: 123,
      exitCode: null,
      childIds: [],
    },
    binding: {
      key: `workspace:${cwd}`,
      sessionId,
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd,
      sandbox: "read-only",
      scope,
      grant: { subjectSessionId: sessionId, capabilities: ["thread.list"], scope },
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe("Cyberdeck CLI", () => {
  it("opens the fleet when invoked without a subcommand", async () => {
    const runDefault = vi.fn(async () => {});

    await createProgram({ runDefault }).parseAsync([], { from: "user" });

    expect(runDefault).toHaveBeenCalledOnce();
  });

  it("exposes a graceful broker restart command", async () => {
    const restartBroker = vi.fn(async () => {});
    const program = createProgram({ restartBroker });
    const broker = program.commands.find((candidate) => candidate.name() === "broker")!;
    const restart = broker.commands.find((candidate) => candidate.name() === "restart")!;

    await restart.parseAsync([], { from: "user" });

    expect(restartBroker).toHaveBeenCalledOnce();
  });

  it("requires explicit provider and cwd for start", async () => {
    await expect(
      quietCommand("start").parseAsync(["--cwd", "/tmp/repo"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    await expect(
      quietCommand("start").parseAsync(["--provider", "codex"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });

  it("requires parent, provider, and cwd for delegation", async () => {
    await expect(
      quietCommand("delegate").parseAsync(["--parent", crypto.randomUUID(), "--cwd", "/tmp/repo"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });

  it("defines no default model, role, or workflow", () => {
    const program = createProgram();
    for (const commandName of ["start", "delegate"]) {
      const command = program.commands.find((candidate) => candidate.name() === commandName)!;
      expect(command.options.find(({ long }) => long === "--model")?.defaultValue).toBeUndefined();
      expect(command.options.find(({ long }) => long === "--role")?.defaultValue).toBeUndefined();
      expect(command.options.some(({ long }) => long === "--workflow")).toBe(false);
    }
  });

  it("states the Fable boundary in help", () => {
    let help = "";
    const program = createProgram().configureOutput({ writeOut: (chunk) => { help += chunk; } });
    program.outputHelp();
    expect(help).toContain("operator-selected Fable starts are allowed");
    expect(help).toContain("worker.start.fable grant");
  });

  it("preflights tmux before ensuring an orchestrator", async () => {
    const order: string[] = [];
    const ensureOrchestrator = vi.fn(async () => {
      order.push("ensure");
      return orchestratorResult(false);
    });
    const launchCockpit = vi.fn(() => order.push("present"));
    const program = createProgram({
      preflightCockpit: () => {
        order.push("preflight");
        return { tmuxVersion: "tmux 3.5a", presentationCommand: "switch-client" };
      },
      ensureOrchestrator,
      launchCockpit,
    });
    const cockpit = program.commands.find((candidate) => candidate.name() === "cockpit")!;

    await cockpit.parseAsync([], { from: "user" });

    expect(order).toEqual(["preflight", "ensure", "present"]);
    expect(ensureOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ scope: "fleet" }));
    expect(launchCockpit).toHaveBeenCalledWith(expect.objectContaining({
      preflight: { tmuxVersion: "tmux 3.5a", presentationCommand: "switch-client" },
    }));
  });

  it("keeps workspace orchestration as an explicit isolation option", async () => {
    const ensureOrchestrator = vi.fn(async () => orchestratorResult(false));
    const program = createProgram({
      preflightCockpit: () => ({ tmuxVersion: "tmux 3.5a", presentationCommand: "attach-session" }),
      ensureOrchestrator,
      launchCockpit: vi.fn(),
    });
    const cockpit = program.commands.find((candidate) => candidate.name() === "cockpit")!;

    await cockpit.parseAsync(["--scope", "workspace", "--orchestrator", "codex"], { from: "user" });

    expect(ensureOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ scope: "workspace" }));
  });

  it("forwards explicit orchestrator effort from the long command", async () => {
    const ensureOrchestrator = vi.fn(async () => orchestratorResult(false));
    const program = createProgram({
      preflightCockpit: () => ({ tmuxVersion: "tmux 3.5a", presentationCommand: "attach-session" }),
      ensureOrchestrator,
      launchCockpit: vi.fn(),
    });
    const cockpit = program.commands.find((candidate) => candidate.name() === "cockpit")!;

    await cockpit.parseAsync([
      "--orchestrator", "codex",
      "--model", "gpt-5.6-sol",
      "--effort", "xhigh",
    ], { from: "user" });

    expect(ensureOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ effort: "xhigh" }));
  });

  it("stops a newly created orchestrator when cockpit presentation fails", async () => {
    const stopSession = vi.fn(async () => {});
    const program = createProgram({
      preflightCockpit: () => ({ tmuxVersion: "tmux 3.5a", presentationCommand: "attach-session" }),
      ensureOrchestrator: vi.fn(async () => orchestratorResult(true)),
      launchCockpit: () => { throw new Error("presentation failed"); },
      stopSession,
    });
    const cockpit = program.commands.find((candidate) => candidate.name() === "cockpit")!;

    await expect(cockpit.parseAsync([], { from: "user" })).rejects.toThrow("presentation failed");
    expect(stopSession).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("preserves a reused orchestrator when cockpit presentation fails", async () => {
    const stopSession = vi.fn(async () => {});
    const program = createProgram({
      preflightCockpit: () => ({ tmuxVersion: "tmux 3.5a", presentationCommand: "attach-session" }),
      ensureOrchestrator: vi.fn(async () => orchestratorResult(false)),
      launchCockpit: () => { throw new Error("presentation failed"); },
      stopSession,
    });
    const cockpit = program.commands.find((candidate) => candidate.name() === "cockpit")!;

    await expect(cockpit.parseAsync([], { from: "user" })).rejects.toThrow("presentation failed");
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("keeps presentation failure primary when stopping a new orchestrator also fails", async () => {
    const program = createProgram({
      preflightCockpit: () => ({ tmuxVersion: "tmux 3.5a", presentationCommand: "attach-session" }),
      ensureOrchestrator: vi.fn(async () => orchestratorResult(true)),
      launchCockpit: () => { throw new Error("presentation failed"); },
      stopSession: vi.fn(async () => { throw new Error("broker disconnected"); }),
    });
    const cockpit = program.commands.find((candidate) => candidate.name() === "cockpit")!;

    await expect(cockpit.parseAsync([], { from: "user" })).rejects.toThrow(
      "presentation failed; cleanup also failed to stop the newly created orchestrator: broker disconnected",
    );
  });

  it("exposes workspace-scoped orchestrator binding reset", async () => {
    const resetOrchestrator = vi.fn(async () => ({
      key: "workspace:/Users/brandon",
      reset: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
    }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = createProgram({ resetOrchestrator });
    const orchestrator = program.commands.find((candidate) => candidate.name() === "orchestrator")!;
    const reset = orchestrator.commands.find((candidate) => candidate.name() === "reset")!;

    try {
      await reset.parseAsync(["--scope", "workspace", "--cwd", "/Users/brandon"], { from: "user" });
    } finally {
      write.mockRestore();
    }

    expect(resetOrchestrator).toHaveBeenCalledWith({ cwd: "/Users/brandon", scope: "workspace" });
  });

  it("resets the fleet binding by default", async () => {
    const resetOrchestrator = vi.fn(async () => ({ key: "fleet", reset: false }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = createProgram({ resetOrchestrator });
    const orchestrator = program.commands.find((candidate) => candidate.name() === "orchestrator")!;
    const reset = orchestrator.commands.find((candidate) => candidate.name() === "reset")!;

    try {
      await reset.parseAsync([], { from: "user" });
    } finally {
      write.mockRestore();
    }

    expect(resetOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ scope: "fleet" }));
  });

  it("enables Fable workers on the fleet binding through the operator CLI", async () => {
    const fableWorkers = vi.fn(async () => ({
      key: "fleet",
      configured: true,
      enabled: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
    }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = createProgram({ fableWorkers });
    const orchestrator = program.commands.find((candidate) => candidate.name() === "orchestrator")!;
    const command = orchestrator.commands.find((candidate) => candidate.name() === "fable-workers")!;

    try {
      await command.parseAsync(["on"], { from: "user" });
    } finally {
      write.mockRestore();
    }

    expect(fableWorkers).toHaveBeenCalledWith(expect.objectContaining({
      scope: "fleet",
      enabled: true,
    }));
  });

  it("enables the box-wide Caveman worker default through the operator CLI", async () => {
    const cavemanWorkers = vi.fn(async () => ({
      scope: "box" as const,
      enabled: true,
    }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = createProgram({ cavemanWorkers });
    const orchestrator = program.commands.find((candidate) => candidate.name() === "orchestrator")!;
    const command = orchestrator.commands.find((candidate) => candidate.name() === "caveman-workers")!;

    try {
      await command.parseAsync(["on"], { from: "user" });
    } finally {
      write.mockRestore();
    }

    expect(cavemanWorkers).toHaveBeenCalledWith({ enabled: true });
  });
});
