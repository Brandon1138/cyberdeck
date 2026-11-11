import { resolve } from "node:path";
import type { SessionRecord } from "../domain/session.js";
import type { FleetProjectionSnapshot } from "../domain/fleet-projection.js";
import type { CodexConversationBindingStore } from "./codex-conversation-bindings.js";
import { CodexNativeAgentInventory } from "./codex-native-agent-inventory.js";

/** Codex isolates orchestrator SQLite state; ordinary workers retain the source home. */
export class CodexNativeAgentSources {
  private readonly orchestratorHome: string;
  private readonly workerHome: string;
  private readonly sources = new Map<string, CodexNativeAgentInventory>();
  constructor(options: { orchestratorHome: string; workerHome: string; bindings: CodexConversationBindingStore }) {
    this.orchestratorHome = resolve(options.orchestratorHome);
    this.workerHome = resolve(options.workerHome);
    for (const home of new Set([this.orchestratorHome, this.workerHome])) {
      this.sources.set(home, new CodexNativeAgentInventory(home, options.bindings));
    }
  }
  get notice(): string | undefined {
    const notices = [...new Set([...this.sources.values()].flatMap(source => source.notice === undefined ? [] : [source.notice]))];
    return notices.length === 0 ? undefined : notices.join(" · ");
  }
  async list(sessions: readonly SessionRecord[]): Promise<FleetProjectionSnapshot["threads"]> {
    const results = await Promise.all([...this.sources].map(([home, source]) => source.list(sessions.filter(session =>
      session.provider === "codex" && (session.kind === "orchestrator" ? this.orchestratorHome : this.workerHome) === home))));
    return results.flat();
  }
}
