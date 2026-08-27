import { Command, Option } from "commander";
import type { SessionRecord } from "../domain/session.js";
import type { CliProgramContext } from "./program.js";
import { DelegateOptions, SessionLaunchRecordResult, StartOptions, addSessionOptions, openWorkerWorktree, runAttachment, sessionRequest, withClient } from "./runtime.js";

export function registerSessionCommands(program: Command, context: CliProgramContext): void {
  const { toolkit } = context;
  addSessionOptions(program.command("start").description("start a durable top-level session"), true)
    .action(async (options: StartOptions) => {
      const record = await withClient((client) => client.request<SessionRecord>("session.start", sessionRequest(options)));
      process.stdout.write(`${record.id}\n`);
      if (options.attach === true) {
        await runAttachment(record.id, "control", toolkit);
      }
    });

  addSessionOptions(
    program.command("delegate").description("start one explicitly selected delegated worker")
      .requiredOption("--parent <session-id>", "parent session UUID"),
    false,
  ).action(async (options: DelegateOptions) => {
    const record = await withClient((client) =>
      client.request<SessionRecord>("session.start", sessionRequest(options, options.parent)),
    );
    process.stdout.write(`${record.id}\n`);
  });

  program.command("list")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { json?: boolean; }) => {
      const sessions = await withClient((client) => client.request<SessionRecord[]>("session.list", {}));
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
        return;
      }
      for (const session of sessions) {
        process.stdout.write(
          `${session.id} ${session.provider} ${session.model ?? "native-default"} ${session.role ?? "unassigned"} ${session.executionState} ${session.attachmentState} ${session.cwd}\n`,
        );
      }
    });

  program.command("send")
    .argument("<id>", "session UUID")
    .argument("<message>", "message to submit")
    .action(async (sessionId: string, message: string) => {
      await withClient((client) => client.request("session.submit", { sessionId, message }));
    });

  program.command("stop")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      await withClient((client) => client.request("session.stop", { sessionId }));
    });

  // The nvim being opened into is the one in this client's tmux window, so this verb is only
  // meaningful run from that window — the same place the Fleet keybinding runs from.
  program.command("open")
    .description("open a worker's worktree in the nvim running in this tmux window")
    .argument("<id>", "session UUID or exact session name")
    .action(async (query: string) => {
      const notice = await withClient(async (client) => {
        const sessions = await client.request<SessionRecord[]>("session.list", {});
        return await openWorkerWorktree(toolkit.selectSession(sessions, query), client, {
          // This verb opens in its caller's window, which need not be Fleet's. Automatic geometry
          // is intentionally reserved for Fleet's Ctrl+N and its own window-scoped hooks.
          enabled: false,
          orchestratorSessionIds: sessions
            .filter((session) => session.kind === "orchestrator")
            .map((session) => session.id),
        }, toolkit);
      });
      process.stdout.write(`${notice}\n`);
    });

  program.command("logs")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      const snapshot = await withClient((client) => client.request<{ data: string; }>("session.snapshot", { sessionId }));
      process.stdout.write(Buffer.from(snapshot.data, "base64"));
    });

  // Read-only. The broker records what it actually spawned; reconstructing a spec here would both
  // run provider preflight (writing files as a side effect of an inspection) and report a spec the
  // running process was never launched with. Environment values never leave the broker.
  program.command("launch-spec")
    .description("print the sanitized launch record the broker resolved for one session")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      const result = await withClient((client) =>
        client.request<SessionLaunchRecordResult>("session.launchRecord", { sessionId }));
      if (result.launchRecord === null) {
        throw new Error(`No resolved launch record has been captured for session ${sessionId}`);
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  program.command("attach")
    .argument("<id>", "session UUID")
    .addOption(new Option("--cockpit-return <mode>", "return the tmux client to Fleet on explicit detach")
      .choices(["detach", "switch"]))
    .action((sessionId: string, options: { cockpitReturn?: "detach" | "switch"; }) =>
      runAttachment(sessionId, "control", toolkit, options));

  program.command("watch")
    .argument("<id>", "session UUID")
    .action((sessionId: string) => runAttachment(sessionId, "watch", toolkit));

}

