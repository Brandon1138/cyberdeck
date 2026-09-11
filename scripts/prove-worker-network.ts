import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { OrbStackClient } from "../src/runtime/execution/orbstack-client.js";
import { OrbStackExecutor } from "../src/runtime/execution/orbstack-executor.js";
import { WorkerEgressProxy } from "../src/runtime/execution/worker-egress-proxy.js";
import { WorkerGateway } from "../src/broker/worker-gateway.js";
import { containerLaunchContext, type ContainerLaunchContext } from "../src/runtime/execution/container-launch-context.js";
import { createSessionRuntime } from "../src/runtime/session-runtime-adapter.js";
import type { SessionRecord } from "../src/domain/session.js";
import type { PreparedExecution } from "../src/orchestration/session/execution-ports.js";

// Real production executor and gateway, two scripted writable guests, no provider credentials.
const evidence = await mkdtemp(join(tmpdir(), "cyberdeck-network-proof-"));
console.log(JSON.stringify({ evidence }));
const client = new OrbStackClient(`unix://${process.env.HOME}/.orbstack/run/docker.sock`);
const image = (await client.command(["image", "inspect", process.argv[2] ?? "cyberdeck-worker:network-20260909", "--format", "{{.Id}}"])).trim();
const brokerId = randomUUID(), contexts = new Map<string, ContainerLaunchContext>(), prepared: PreparedExecution[] = [];
const proxy = new WorkerEgressProxy(), proxyPort = await proxy.listen();
const gateway = new WorkerGateway({ submit: async () => ({ code: "accepted" }) } as never, () => true);
const reportPort = await gateway.listen();
let hostHits = 0;
const host = createServer((_request, response) => { hostHits++; response.end("HOST_SENTINEL"); });
await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
const hostPort = (host.address() as AddressInfo).port;
const failures: string[] = [], results: unknown[] = [];
const backend = new OrbStackExecutor({ client, profile: { image, cpus: 1, memoryBytes: 256 * 1024 ** 2, slots: 2, network: "egress" },
  writableProxyPort: proxyPort, attach: createSessionRuntime, evidenceDirectory: join(evidence, "collected"), onFailure: error => failures.push(String(error)),
  contexts: { prepare: async input => {
    const base = join(evidence, input.identity.executionId);
    const context = containerLaunchContext({ hostState: join(base, "home"), hostCredentials: join(base, "credentials"),
      reportingUrl: `http://host.docker.internal:${reportPort}/v1/report`, workspace: { mode: "independent-clone", executionId: input.identity.executionId,
        hostPath: join(base, "workspace"), guestPath: "/workspace", source: evidence, baseCommit: "a".repeat(40), branch: "fixture", manifestHash: "b".repeat(64) } });
    for (const path of [context.hostState, context.hostCredentials, context.workspace.hostPath]) await mkdir(path, { recursive: true, mode: 0o700 });
    const token = gateway.issue({ workerId: input.record.id, executionId: input.identity.executionId, generation: 1 });
    await writeFile(join(context.hostCredentials, "reporting-token"), token, { mode: 0o600 });
    contexts.set(input.identity.executionId, context); return context;
  }, get: async ref => contexts.get(ref.executionId)! },
});
let success = false;
try {
  for (let index = 0; index < 2; index++) {
    const id = randomUUID();
    const item = await backend.prepare({ identity: { brokerId, executionId: randomUUID(), workerId: id, sessionId: id, generation: 1 },
      record: { id, sandbox: "workspace-write", provider: "codex" } as SessionRecord,
      request: { executor: "orbstack-container", profile: "ordinary" }, launch: { executable: "node", args: ["-e",
        "require('net').createServer(s=>s.end('WORKER_SENTINEL')).listen(22000,'0.0.0.0',()=>console.log('READY'));"], cwd: "/workspace", env: {}, transport: "pipe" } });
    prepared.push(item);
    const runtime = await backend.start(item, 4096);
    const deadline = Date.now() + 10000;
    while (!runtime.snapshot().includes("READY")) {
      if (Date.now() > deadline) throw new Error(`SCRIPTED_WORKER_NOT_READY:${runtime.snapshot()}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const ips = await Promise.all(prepared.map(item => client.command(["inspect", item.ref.backendId!, "--format", "{{(index .NetworkSettings.Networks \"bridge\").IPAddress}}"]))) ;
  for (const [index, item] of prepared.entries()) {
    const checks = { hostPort, reportPort, proxyPort, otherIp: ips[1 - index]!.trim(), workerId: item.ref.workerId,
      otherId: prepared[1 - index]!.ref.workerId };
    const output = await client.command(["exec", item.ref.backendId!, "node", "--input-type=module", "-e", `
      import net from 'node:net'; import tls from 'node:tls'; import fs from 'node:fs'; import dns from 'node:dns/promises';
      const c=${JSON.stringify(checks)};
      const tcp=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});const done=value=>{s.destroy();resolve(value)};s.setTimeout(700,()=>done(false));s.on('connect',()=>done(true));s.on('error',()=>done(false))});
      const hostIp=(await dns.lookup('host.docker.internal',{family:4})).address;
      const route=fs.readFileSync('/proc/net/route','utf8').split('\\n').find(l=>l.split(/\\s+/)[1]==='00000000');
      const raw=route?.split(/\\s+/)[2];const bridge=raw?raw.match(/../g).reverse().map(x=>parseInt(x,16)).join('.'):undefined;
      const targets=[['host-alias','host.docker.internal',c.hostPort],['host-ip',hostIp,c.hostPort],['host-gateway',bridge,c.hostPort],
        ['localhost','127.0.0.1',c.hostPort],['cross-worker',c.otherIp,22000],['private','192.168.1.1',443],['metadata','169.254.169.254',80],
        ['direct-public','1.1.1.1',443],['ipv6-loopback','::1',c.hostPort],['ipv6-private','fd00::1',443]];
      const denied=await Promise.all(targets.map(async([name,host,port])=>({name,reachable:host?await tcp(host,port):false})));
      const token=fs.readFileSync('/run/credentials/reporting-token','utf8').trim();
      const gateway='http://host.docker.internal:'+c.reportPort;
      const ready=(await fetch(gateway+'/v1/ready',{headers:{authorization:'Bearer '+token}})).status;
      const crossReport=(await fetch(gateway+'/v1/report',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({workerId:c.otherId,eventId:'cross',kind:'PROGRESS',summary:'fixture'})})).status;
      const ownReport=(await fetch(gateway+'/v1/report',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({workerId:c.workerId,eventId:'own',kind:'PROGRESS',summary:'fixture'})})).status;
      const https=hostname=>new Promise(resolve=>{const s=net.connect(c.proxyPort,'host.docker.internal',()=>s.write('CONNECT '+hostname+':443 HTTP/1.1\\r\\nHost: '+hostname+':443\\r\\n\\r\\n'));s.setTimeout(15000,()=>{s.destroy();resolve('timeout')});s.on('error',()=>resolve('error'));s.once('data',data=>{if(!data.toString().startsWith('HTTP/1.1 200')){s.destroy();resolve(data.toString().split('\\r\\n')[0]);return;}const secure=tls.connect({socket:s,servername:hostname,rejectUnauthorized:true},()=>secure.write('HEAD / HTTP/1.1\\r\\nHost: '+hostname+'\\r\\nConnection: close\\r\\n\\r\\n'));secure.on('error',()=>{secure.destroy();resolve('tls-error')});secure.once('data',data=>{secure.destroy();resolve('TLS '+data.toString().split('\\r\\n')[0])});});});
      const providers=Object.fromEntries(await Promise.all(['chatgpt.com','auth.openai.com','api.openai.com','api.anthropic.com','host.docker.internal','127.0.0.1'].map(async h=>[h,await https(h)])));
      const caps=fs.readFileSync('/proc/self/status','utf8').split('\\n').filter(l=>/^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/.test(l));
      const forbidden=['/Users/brandon/.codex/auth.json','/var/run/docker.sock','/run/credentials/../other','/home/worker/../other'];
      const inaccessible=forbidden.every(p=>!fs.existsSync(p));let outsideWriteDenied=false;try{fs.writeFileSync('/etc/cyberdeck-probe','x')}catch{outsideWriteDenied=true}
      fs.writeFileSync('/workspace/writable-proof','ok');
      let firewallChangeDenied=false;try{require}catch{};
      const {spawnSync}=await import('node:child_process');firewallChangeDenied=spawnSync('/usr/sbin/iptables',['-P','OUTPUT','ACCEPT']).status!==0;
      console.log(JSON.stringify({denied,ready,crossReport,ownReport,providers,caps,inaccessible,outsideWriteDenied,firewallChangeDenied,uid:process.getuid()}));
    `]);
    const result = JSON.parse(output); results.push(result);
    assert.ok(result.denied.every((entry: { reachable: boolean }) => !entry.reachable), "NETWORK_ESCAPE");
    assert.equal(result.ready, 200); assert.equal(result.ownReport, 200); assert.equal(result.crossReport, 403);
    for (const name of ["chatgpt.com", "auth.openai.com", "api.openai.com", "api.anthropic.com"]) assert.match(result.providers[name], /^TLS HTTP\/1\.[01] [1-5][0-9][0-9]/);
    for (const name of ["host.docker.internal", "127.0.0.1"]) assert.equal(result.providers[name], "HTTP/1.1 403 Forbidden");
    assert.equal(result.uid, 1000); assert.ok(result.inaccessible && result.outsideWriteDenied && result.firewallChangeDenied);
    assert.ok(result.caps.every((line: string) => line.startsWith("NoNewPrivs:") ? /1$/.test(line) : /0000000000000000$/.test(line)));
    const context = contexts.get(item.ref.executionId)!;
    assert.equal(await readFile(join(context.workspace.hostPath, "writable-proof"), "utf8"), "ok");
  }
  assert.equal(hostHits, 0); assert.deepEqual(failures, []); success = true;
} finally {
  for (const item of prepared) {
    await backend.stop(item.ref, true);
    await backend.collect(item.ref); await backend.destroy(item.ref);
  }
  await proxy.close(); await gateway.close(); await new Promise<void>(resolve => host.close(() => resolve()));
  const remaining = (await client.command(["ps", "-a", "--filter", `label=cyberdeck.broker=${brokerId}`, "--format", "{{.ID}}"])).trim();
  await writeFile(join(evidence, "result.json"), JSON.stringify({ success, image, results, hostHits, failures, remaining }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence, success, hostHits, remaining }));
  assert.equal(remaining, "");
}
