/** Require the actual printf tool result, not an assistant's unverified claim of success. */
export function successfulCanaryTool(provider: string, frames: Array<Record<string, any>>): boolean {
  const calls = new Set<string>();
  for (const frame of frames) {
    if (provider === "codex") {
      const p = frame.type === "response_item" ? frame.payload : undefined;
      if (p?.type === "function_call" && ["exec_command", "shell_command"].includes(p.name)) {
        try { if (JSON.parse(p.arguments).cmd?.trim() === "printf 'SUBSCRIPTION_CANARY_OK\\n'") calls.add(p.call_id); } catch { /* incomplete frame */ }
      }
      if (p?.type === "function_call_output" && calls.has(p.call_id) && typeof p.output === "string"
        && /Process exited with code 0/.test(p.output) && p.output.includes("SUBSCRIPTION_CANARY_OK")) return true;
      if (p?.type === "custom_tool_call" && p.name === "exec" && typeof p.input === "string"
        && p.input.includes("tools.exec_command(") && p.input.includes("SUBSCRIPTION_CANARY_OK")) calls.add(p.call_id);
      if (p?.type === "custom_tool_call_output" && calls.has(p.call_id) && Array.isArray(p.output)) {
        const texts = p.output.filter((item: any) => item.type === "input_text").map((item: any) => item.text);
        if (texts.some((text: unknown) => typeof text === "string" && text.trim() === "SUBSCRIPTION_CANARY_OK")
          && texts.includes("exit_code=0")) return true;
        for (const item of p.output) {
          if (item.type !== "input_text" || typeof item.text !== "string") continue;
          try {
            const result = JSON.parse(item.text);
            if (result.exit_code === 0 && typeof result.output === "string" && result.output.trim() === "SUBSCRIPTION_CANARY_OK") return true;
          } catch { /* A prose claim or wrapper success alone is not command evidence. */ }
        }
      }
    } else if (provider === "claude") {
      for (const block of frame.message?.content ?? []) {
        if (block.type === "tool_use" && block.name === "Bash" && block.input?.command?.trim() === "printf 'SUBSCRIPTION_CANARY_OK\\n'") calls.add(block.id);
        if (block.type === "tool_result" && calls.has(block.tool_use_id) && block.is_error !== true
          && JSON.stringify(block.content).includes("SUBSCRIPTION_CANARY_OK")) return true;
      }
    }
  }
  return false;
}
