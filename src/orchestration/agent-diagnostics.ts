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
