import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Command } from "commander";
import { StrigoiSelectionSchema } from "../domain/strigoi.js";
import { LegacyRetirementRequestSchema } from "../domain/strigoi-legacy-retirement.js";
import type { CliProgramContext } from "./program.js";
export function registerStrigoiCommands(program: Command, context: CliProgramContext): void {
  const root = program.command("strigoi").description("Explicit control of the single resident Strigoi");
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  root.command("enable").requiredOption("--provider <provider>").requiredOption("--model <id>").requiredOption("--cwd <absolute-path>")
    .option("--effort <effort>").option("--mutation-id <id>").action(async options => {
      const { mutationId, ...input } = options;
      const selection = StrigoiSelectionSchema.parse(input);
      if (!isAbsolute(selection.cwd)) throw new Error("Strigoi cwd must be absolute");
      print(await context.strigoi("configure", { ...selection, mutationId: mutationId ?? randomUUID() }));
    });
  root.command("watch").description("Follow resident output read-only across renewal").action(async () => { process.exitCode = await context.strigoiWatch(); });
  root.command("status").action(async () => print(await context.strigoi("inspect", {})));
  root.command("reconcile-legacy").description("Inspect legacy retirement evidence; confirmation requires suspended residence and audited PTY provenance")
    .option("--confirm-host-pty-provenance").option("--session-id <id>").option("--generation <number>")
    .option("--pid <number>").option("--transition-id <id>").option("--expected-revision <number>")
    .option("--record-sha256 <hash>").option("--mutation-id <id>").option("--provenance <evidence>")
    .option("--managed-home <absolute-path>").option("--confirm-managed-daemon-provenance")
    .action(async options => {
      if (!options.confirmHostPtyProvenance) { print(await context.strigoi("legacyRetirementInspect", {})); return; }
      const request = LegacyRetirementRequestSchema.parse({ ...options, generation: Number(options.generation),
        pid: Number(options.pid), expectedRevision: Number(options.expectedRevision) });
      print(await context.strigoi("legacyRetirementConfirm", request));
    });
  for (const method of ["suspend", "resume", "disable"] as const) root.command(method).option("--mutation-id <id>")
    .action(async options => print(await context.strigoi(method, { mutationId: options.mutationId ?? randomUUID() })));
  root.command("renew").option("--reason <reason>", "Renewal reason", "operator-request").option("--mutation-id <id>")
    .action(async options => {
      const inspection = await context.strigoi("inspect", {}) as { state: { incarnation: number } };
      print(await context.strigoi("renew", { expectedIncarnation: inspection.state.incarnation, reason: options.reason, mutationId: options.mutationId ?? randomUUID() }));
    });
  root.command("say <message>").option("--message-id <id>").action(async (message, options) =>
    print(await context.strigoi("submit", { message, messageId: options.messageId ?? randomUUID() })));
}
