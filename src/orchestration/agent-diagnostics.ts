export type AgentBrokerStatus = "reachable" | "unreachable" | "outdated";

export interface AgentDiagnosticState {
  actor: unknown;
  actorStatus?: string;
  brokerError?: string;
  brokerStatus: AgentBrokerStatus;
}

export interface InspectAgentDiagnosticStateInput {
  actorSessionId: string;
  brokerUnavailable?: string;
  describeActor?: (actorSessionId: string) => Promise<unknown>;
}

export interface DiagnoseAgentInput extends InspectAgentDiagnosticStateInput {
  conversationDrifted: boolean;
}

export interface AgentDiagnostic extends AgentDiagnosticState {
  remedy: string;
  status: string;
}

const BROKER_UNREACHABLE_REMEDY =
  "The Cyberdeck broker is not accepting connections. Start it with `cyberdeck up`, then reconnect this server with /mcp.";
const BROKER_OUTDATED_REMEDY =
  "The running broker is older than this MCP server and does not implement the method it called. Rebuild, then `cyberdeck restart` — the broker runs compiled output, so a restart without a rebuild silently keeps the old build.";
const DEFAULT_REMEDY =
  "Cyberdeck tools are resolvable. If a cyberdeck_* tool still looks missing, the harness tool index is at fault, not this server.";

export async function diagnoseAgent(input: DiagnoseAgentInput): Promise<AgentDiagnostic> {
  const state = await inspectAgentDiagnosticState(input);
  const { actor, actorStatus, brokerError, brokerStatus } = state;
  const status = brokerStatus === "unreachable" && brokerError !== undefined
    ? "broker-unreachable"
    : brokerStatus === "outdated"
      ? "broker-outdated"
      : actorStatus === undefined
        ? "unknown"
        : actorStatus === "bound"
          ? (input.conversationDrifted ? "conversation-drifted" : "healthy")
          : actorStatus;
  const remedy = brokerStatus === "outdated"
    ? BROKER_OUTDATED_REMEDY
    : brokerError !== undefined
      ? BROKER_UNREACHABLE_REMEDY
      : isRecord(actor) && typeof actor.remedy === "string"
        ? actor.remedy
        : DEFAULT_REMEDY;
  return { ...state, status, remedy };
}

/**
 * Reads actor binding and classifies broker reachability for diagnostic presentation.
 *
 * Caller supplies actor reader and decides how to render this state. Keeping request, failure
 * classification, and actor-state interpretation together gives every caller one diagnostic
 * result without coupling this use case to a transport.
 */
export async function inspectAgentDiagnosticState(
  input: InspectAgentDiagnosticStateInput,
): Promise<AgentDiagnosticState> {
  let actor: unknown;
  let brokerError = input.brokerUnavailable;
  let brokerStatus: AgentBrokerStatus = brokerError === undefined ? "reachable" : "unreachable";
  if (input.describeActor !== undefined) {
    try {
      actor = await input.describeActor(input.actorSessionId);
    } catch (error) {
      brokerError = error instanceof Error ? error.message : String(error);
      brokerStatus = errorCode(error) === "METHOD_NOT_FOUND" ? "outdated" : "unreachable";
    }
  }
  const actorStatus = isRecord(actor) && typeof actor.status === "string"
    ? actor.status
    : undefined;
  return {
    actor,
    ...(actorStatus === undefined ? {} : { actorStatus }),
    ...(brokerError === undefined ? {} : { brokerError }),
    brokerStatus,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
