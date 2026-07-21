import { createInterface } from "node:readline";

const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(frame, partial = false) {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (!partial) {
    process.stdout.write(encoded);
    return;
  }
  const midpoint = Math.max(1, Math.floor(encoded.length / 2));
  process.stdout.write(encoded.slice(0, midpoint));
  setImmediate(() => process.stdout.write(encoded.slice(midpoint)));
}

lineReader.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        userAgent: "codex-cli 0.144.6 fixture",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    }, true);
  } else if (frame.method === "thread/start") {
    send({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        cwd: frame.params.cwd,
        model: frame.params.model ?? "fixture-default",
        modelProvider: "openai",
        sandbox: { type: frame.params.sandbox === "read-only" ? "readOnly" : "workspaceWrite" },
        thread: { id: "fixture-thread" },
      },
    });
  } else if (frame.method === "turn/start") {
    send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "fixture-turn" } } });
    setImmediate(() => {
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          completedAtMs: 1,
          item: { id: "fixture-item", type: "agentMessage", text: "fake App Server completed" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "fixture-thread",
          turn: { id: "fixture-turn", status: "completed", items: [] },
        },
      });
    });
  } else if (frame.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: frame.id, result: {} });
  }
});

lineReader.on("close", () => process.exit(0));
