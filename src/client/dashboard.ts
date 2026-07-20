import type { SessionRecord } from "../domain/session.js";
import type { RpcClient } from "./rpc-client.js";

interface DashboardOutput {
  write(chunk: string): unknown;
}

interface DashboardSignals {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function renderDashboard(sessions: readonly SessionRecord[]): string {
  const header = ["SESSION", "PROVIDER", "MODEL", "ROLE", "EXECUTION", "ATTACHMENT", "CWD"].join("\t");
  const rows = sessions.map((session) => [
    session.id.slice(0, 8),
    session.provider,
    session.model ?? "native-default",
    session.role ?? "unassigned",
    session.executionState,
    session.attachmentState,
    session.cwd,
  ].join("\t"));
  return `${header}\n${rows.join("\n")}\n`;
}

export async function runDashboard(
  client: RpcClient,
  output: DashboardOutput = process.stdout,
  signals: DashboardSignals = process,
): Promise<void> {
  let stopped = false;
  const stop = () => { stopped = true; };
  const unsubscribeClose = client.onClose(stop);
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);

  try {
    while (!stopped) {
      const sessions = await client.request<SessionRecord[]>("session.list", {});
      output.write(`\u001b[2J\u001b[H${renderDashboard(sessions)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    unsubscribeClose();
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    client.close();
  }
}
