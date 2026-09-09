import { connect } from "node:net";
import { expect, it } from "vitest";
import { permittedConnectTarget, publicWorkerAddress, resolveWorkerDestination, WorkerEgressProxy } from "../../../src/runtime/execution/worker-egress-proxy.js";

it.each(["host.docker.internal:443", "host-gateway:443", "localhost:443", "127.0.0.1:443", "192.168.1.1:443",
  "[::1]:443", "api.openai.com:80", "api.openai.com:443@localhost", "api.openai.com.evil.test:443", "chatgpt.com.:443"])
  ("denies unapproved CONNECT authority %s", (target) => expect(permittedConnectTarget(target)).toBeUndefined());
it.each(["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.1.1", "169.254.169.254", "172.17.0.2", "192.168.215.2",
  "192.0.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "fc00::1"])
  ("denies host/private/special destination %s", (address) => expect(publicWorkerAddress(address)).toBe(false));
it.each(["api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com"])("permits pinned public provider/auth resolution for %s", async (hostname) => {
  expect(permittedConnectTarget(`${hostname}:443`)).toBe(hostname);
  expect(await resolveWorkerDestination(hostname, async () => [{ address: "1.1.1.1" }])).toBe("1.1.1.1");
});
it("rejects DNS rebinding, mixed answers, empty answers, and destinations outside the allowlist", async () => {
  for (const addresses of [[], [{ address: "127.0.0.1" }], [{ address: "1.1.1.1" }, { address: "172.17.0.2" }]]) {
    await expect(resolveWorkerDestination("chatgpt.com", async () => addresses)).rejects.toThrow("WORKER_EGRESS_ADDRESS_REFUSED");
  }
  await expect(resolveWorkerDestination("localhost", async () => [{ address: "1.1.1.1" }])).rejects.toThrow("WORKER_EGRESS_DESTINATION_REFUSED");
});
it("the listening proxy denies raw host HTTP, private CONNECT, and closes upgraded sockets", async () => {
  const proxy = new WorkerEgressProxy(), port = await proxy.listen();
  try {
    for (const request of ["GET http://host.docker.internal:1234/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: localhost\r\n\r\n"]) {
      const response = await new Promise<string>((resolve, reject) => {
        let response = "";
        const socket = connect(port, "127.0.0.1", () => socket.write(request));
        socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));
        socket.on("data", chunk => { response += chunk; }); socket.on("end", () => resolve(response)); socket.on("error", reject);
      });
      expect(response).toMatch(/^HTTP\/1.1 403/);
    }
  } finally { await proxy.close(); }
});
