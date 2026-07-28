import { describe, expect, it } from "vitest";
import type { ProviderSessionTerminal } from "../../src/providers/provider.js";
import {
  cursorInputReady,
  cursorRunEverythingState,
  enableCursorRunEverything,
} from "../../src/providers/cursor/run-everything.js";

class ScriptedTerminal implements ProviderSessionTerminal {
  readonly writes: string[] = [];
  private replay: string;

  constructor(private readonly frames: string[]) {
    this.replay = frames.shift() ?? "";
  }

  snapshot(): Buffer {
    return Buffer.from(this.replay);
  }

  write(data: Buffer): void {
    this.writes.push(data.toString("utf8"));
  }

  async wait(): Promise<void> {
    this.replay += this.frames.shift() ?? "";
  }
}

describe("Cursor /run-everything setup", () => {
  it("waits for input, commits command, reads enabled state back, and closes menu", async () => {
    const terminal = new ScriptedTerminal([
      "Starting Composer",
      "\n→ \n",
      "\nRun Everything enabled\n→ \n",
      [
        "\n→ /",
        "\n/model [filter] Select model (Tab to edit)",
        "\n/run-everything Toggle Run Everything (currently enabled)",
      ].join(""),
    ]);

    await expect(enableCursorRunEverything(terminal, {
      timeoutMs: 50,
      pollIntervalMs: 1,
    })).resolves.toBeUndefined();
    expect(terminal.writes).toEqual(["/run-everything\r", "/", "\u001b"]);
  });

  it("fails clearly when readback remains disabled and still closes menu", async () => {
    const terminal = new ScriptedTerminal([
      "→ \n",
      "Command returned\n→ \n",
      "\n/run-everything Toggle Run Everything (currently disabled)",
    ]);

    await expect(enableCursorRunEverything(terminal, {
      timeoutMs: 50,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({
      code: "PROVIDER_PERMISSION_MODE_NOT_APPLIED",
      message: expect.stringContaining("still reports manual mode"),
    });
    expect(terminal.writes.at(-1)).toBe("\u001b");
  });

  it("recognizes readiness and explicit readback states from rendered Composer text", () => {
    expect(cursorInputReady(Buffer.from("Add a follow-up"))).toBe(true);
    expect(cursorInputReady(Buffer.from("→ Plan, search, build anything"))).toBe(true);
    expect(cursorRunEverythingState(Buffer.from(
      "/run-everything Toggle Run Everything (currently enabled)",
    ))).toBe("enabled");
  });
});
