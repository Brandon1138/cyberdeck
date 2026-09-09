import { expect, it } from "vitest";
import { successfulCanaryTool } from "../../../scripts/subscription-canary-evidence.js";
it("rejects a false completion claim after a failed Codex shell tool", () => {
  const call = { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "one", arguments: JSON.stringify({ cmd: "printf 'SUBSCRIPTION_CANARY_OK\\n'" }) } };
  const failed = { type: "response_item", payload: { type: "function_call_output", call_id: "one", output: "Process exited with code 1\nbwrap: No permissions" } };
  const claim = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "SUBSCRIPTION_CANARY_OK" }] } };
  expect(successfulCanaryTool("codex", [call, failed, claim])).toBe(false);
  expect(successfulCanaryTool("codex", [call, { ...failed, payload: { ...failed.payload, output: "Process exited with code 0\nFinal output:\nSUBSCRIPTION_CANARY_OK" } }])).toBe(true);
});
it("requires Claude's matching Bash result rather than other tool output", () => {
  const call = { message: { content: [{ type: "tool_use", name: "Bash", id: "one", input: { command: "printf 'SUBSCRIPTION_CANARY_OK\\n'" } }] } };
  const result = (tool_use_id: string, is_error: boolean) => ({ message: { content: [{ type: "tool_result", tool_use_id, is_error, content: "SUBSCRIPTION_CANARY_OK" }] } });
  expect(successfulCanaryTool("claude", [call, result("other", false)])).toBe(false);
  expect(successfulCanaryTool("claude", [call, result("one", true)])).toBe(false);
  expect(successfulCanaryTool("claude", [call, result("one", false)])).toBe(true);
});
it("accepts the native Codex exec wrapper only with command output and explicit zero exit status", () => {
  const call = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "one", input: "await tools.exec_command({cmd: \"printf 'SUBSCRIPTION_CANARY_OK\\\\n'\"})" } };
  const result = (text: string) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "one", output: [
    { type: "input_text", text: "SUBSCRIPTION_CANARY_OK\n" }, { type: "input_text", text },
  ] } });
  expect(successfulCanaryTool("codex", [call, result("exit_code=0")])).toBe(true);
  expect(successfulCanaryTool("codex", [call, result("exit_code=1")])).toBe(false);
  expect(successfulCanaryTool("codex", [call, result("Script completed")])).toBe(false);
});
