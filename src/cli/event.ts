import { Command, Option } from "commander";
import type { CliProgramContext } from "./program.js";
import { EventSubmitOptions, collectValue, parseFacts } from "./runtime.js";

export function registerEventCommands(program: Command, context: CliProgramContext): void {
  const { submitWorkerEvent } = context;
  const event = program.command("event").description("submit bounded worker events");
  event.command("submit")
    .description("submit one idempotent worker event")
    .requiredOption("--worker <session-id>", "worker session UUID")
    .requiredOption(
      "--kind <kind>",
      "EXCEPTION, PROGRESS, CHECKPOINT, RISK, or DECISION_REQUEST",
    )
    .requiredOption("--summary <text>", "bounded event summary")
    .option("--event-id <id>", "stable event ID for idempotent retry")
    .addOption(new Option("--severity <severity>")
      .choices(["info", "warning", "error", "critical"])
      .default("info"))
    .option("--intervention", "mark intervention required")
    .option("--facts <json>", "structured facts JSON object")
    .option("--evidence <ref>", "evidence reference; repeatable", collectValue, [])
    .option(
      "--changed-assumption <text>",
      "changed assumption; repeatable",
      collectValue,
      [],
    )
    .option("--recommended-action <text>", "recommended next action")
    .addOption(new Option("--continuation <state>")
      .choices(["continuing", "blocked", "paused", "awaiting-response"])
      .default("continuing"))
    .option("--checkpoint-correlation-id <id>", "pending checkpoint correlation ID")
    .action(async (options: EventSubmitOptions) => {
      const ack = await submitWorkerEvent({
        workerId: options.worker,
        ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
        kind: options.kind,
        severity: options.severity,
        interventionRequired: options.intervention === true,
        summary: options.summary,
        ...(options.facts === undefined
          ? {}
          : { structuredFacts: parseFacts(options.facts) }),
        evidenceRefs: options.evidence,
        changedAssumptions: options.changedAssumption,
        ...(options.recommendedAction === undefined
          ? {}
          : { recommendedAction: options.recommendedAction }),
        continuation: options.continuation,
        ...(options.checkpointCorrelationId === undefined
          ? {}
          : { checkpointCorrelationId: options.checkpointCorrelationId }),
      });
      process.stdout.write(`${JSON.stringify(ack)}\n`);
    });

}


