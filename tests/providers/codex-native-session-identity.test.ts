import { describe, expect, it } from "vitest";
import { codexDeveloperInstructions, codexSessionClaims, codexSessionMarker } from "../../src/providers/codex/native-session-identity.js";
import { bindCodexThreadMcp } from "../../src/providers/codex/remote-mcp-bridge.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";

describe("Codex native identity launch contract", () => {
  it("preserves instructions and injects an idempotent actor-specific marker", () => {
    const instructions = codexDeveloperInstructions(A, "existing developer instructions");
    expect(instructions).toBe(`existing developer instructions\n\n${codexSessionMarker(A)}`);
    expect(codexDeveloperInstructions(A, instructions)).toBe(instructions);
  });
  it.each(["user", "assistant"])("does not trust %s marker quotations", (role) => {
    expect(codexSessionClaims(JSON.stringify({ type: "response_item", payload: { type: "message", role,
      content: [{ type: "input_text", text: codexSessionMarker(A) }] } }))).toEqual([]);
  });
  it("exposes all conflicting claims instead of collapsing them into one", () => {
    expect(codexSessionClaims(JSON.stringify({ type: "turn_context", payload: {
      developer_instructions: `${codexSessionMarker(A)}\n${codexSessionMarker(B)}`,
    } }))).toEqual([A, B]);
  });
  it.each(["thread/start", "thread/resume", "thread/fork"])("binds exact actor at remote %s boundary", (method) => {
    const options = { sessionId: A, homeDirectory: "/mock-home", mcp: { nodePath: "/node", cliPath: "/cli" } };
    const original = { id: 1, method, params: { model: "native-model", developerInstructions: "keep these",
      config: { model_reasoning_effort: "xhigh", "mcp_servers.other": { url: "https://example.test" } } } };
    const transformed = JSON.parse(bindCodexThreadMcp(Buffer.from(JSON.stringify(original)), options).toString());
    expect(transformed.params).toEqual({ ...original.params,
      developerInstructions: codexDeveloperInstructions(A, "keep these"),
      config: { ...original.params.config, "mcp_servers.cyberdeck": {
        command: "/node", args: ["/cli", "mcp", "--actor-session", A],
      } },
    });
    const frame = JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer",
      content: [{ type: "input_text", text: transformed.params.developerInstructions }] } });
    expect(codexSessionClaims(frame)).toEqual([A]);
  });
  it("does not alter unrelated native requests", () => {
    const data = Buffer.from(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "native" } }));
    expect(bindCodexThreadMcp(data, { sessionId: A, homeDirectory: "/mock-home",
      mcp: { nodePath: "/node", cliPath: "/cli" } })).toBe(data);
  });

  it("preserves developer instructions forwarded only through native config", () => {
    const options = { sessionId: A, homeDirectory: "/mock-home", mcp: { nodePath: "/node", cliPath: "/cli" } };
    const data = Buffer.from(JSON.stringify({ id: 1, method: "thread/start", params: {
      developerInstructions: null, config: { developer_instructions: "explicit remote guidance" },
    } }));
    const result = JSON.parse(bindCodexThreadMcp(data, options).toString());
    expect(result.params.developerInstructions).toBe(codexDeveloperInstructions(A, "explicit remote guidance"));
    expect(result.params.config.developer_instructions).toBe("explicit remote guidance");
  });
});
