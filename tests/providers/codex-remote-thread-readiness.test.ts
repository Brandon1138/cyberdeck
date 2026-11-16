import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexRemoteIdle } from "../../src/providers/codex/remote-thread-readiness.js";

describe("Codex current-thread readiness read", () => {
  let root: string, server: Server, ws: WebSocketServer;
  let response: unknown, ignore = false;
  let calls: Array<{method: string; params?: unknown}>;
  beforeEach(async () => {
    root = await mkdtemp("/tmp/cd-ready-");
    await mkdir(join(root,"app-server-control"));
    server = createServer(); ws = new WebSocketServer({server}); calls=[];
    response = {thread:{id:"native",cwd:"/work",path:"/native.jsonl",status:{type:"idle"},canAcceptDirectInput:true}};
    ignore=false;
    ws.on("connection", client => client.on("message", bytes => {
      const frame=JSON.parse(bytes.toString()); calls.push(frame);
      if(ignore)return;
      if(frame.method==="initialize")client.send(JSON.stringify({id:frame.id,result:{}}));
      if(frame.method==="thread/read")client.send(JSON.stringify({id:frame.id,result:response}));
    }));
    server.listen(join(root,"app-server-control","app-server-control.sock"));await once(server,"listening");
  });
  afterEach(async()=>{for(const c of ws.clients)c.terminate();ws.close();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});});
  const input=()=>({homeDirectory:root,nativeSessionId:"native",cwd:"/work",transcriptPath:"/native.jsonl",timeoutMs:100});
  it("reads metadata only and never resumes/starts a thread",async()=>{
    expect(await readCodexRemoteIdle(input())).toBe(true);
    expect(calls.map(c=>c.method)).toEqual(["initialize","initialized","thread/read"]);
    expect(calls.at(-1)?.params).toEqual({threadId:"native",includeTurns:false});
  });
  it.each(["fresh", "preview", "updated", "fork", "ephemeral", "missing"])("checks exact-start metadata without unsupported turn hydration (%s)", async change => {
    const thread = (response as any).thread;
    Object.assign(thread, { preview: "", forkedFromId: null, ephemeral: false, createdAt: 100, updatedAt: 100 });
    if (change === "preview") thread.preview = "earlier input";
    if (change === "updated") thread.updatedAt = 101;
    if (change === "fork") thread.forkedFromId = "old";
    if (change === "ephemeral") thread.ephemeral = true;
    if (change === "missing") delete thread.createdAt;
    expect(await readCodexRemoteIdle({ ...input(), freshBootstrap: true })).toBe(change === "fresh");
    expect(calls.at(-1)?.params).toEqual({ threadId: "native", includeTurns: false });
  });
  it.each(["active","notLoaded","systemError"])("refuses %s",async type=>{
    (response as any).thread.status={type};expect(await readCodexRemoteIdle(input())).toBe(false);
  });
  it.each(["id","cwd","path","canAcceptDirectInput"])("refuses mismatched/unavailable %s",async key=>{
    (response as any).thread[key]=key==="canAcceptDirectInput"?false:"other";expect(await readCodexRemoteIdle(input())).toBe(false);
  });
  it("accepts the exact same transcript through the managed-home symlink",async()=>{
    const original=join(root,"rollout.jsonl"),alias=join(root,"linked.jsonl");
    await writeFile(original,"");await symlink(original,alias);(response as any).thread.path=alias;
    expect(await readCodexRemoteIdle({...input(),transcriptPath:original})).toBe(true);
    await rm(alias);await writeFile(alias,"");
    expect(await readCodexRemoteIdle({...input(),transcriptPath:original})).toBe(false);
  });
  it("bounds a silent daemon and closes the connection",async()=>{
    ignore=true;const start=performance.now();expect(await readCodexRemoteIdle(input())).toBe(false);expect(performance.now()-start).toBeLessThan(1000);
  });
  it("fails closed on malformed payload or missing socket",async()=>{
    response=null;expect(await readCodexRemoteIdle(input())).toBe(false);
    expect(await readCodexRemoteIdle({...input(),homeDirectory:join(root,"missing")})).toBe(false);
  });
});
