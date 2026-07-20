import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";

function quietCommand(name: string) {
  const command = createProgram().commands.find((candidate) => candidate.name() === name)!;
  return command.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
}

describe("Cyberdeck CLI", () => {
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
    expect(help).toContain("Top-level Fable");
    expect(help).toContain("delegated Fable is refused");
  });
});
