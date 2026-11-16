import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import { readCodexRemoteIdle } from "../../src/providers/codex/remote-thread-readiness.js";
vi.mock("../../src/providers/codex/remote-thread-readiness.js",()=>({readCodexRemoteIdle:vi.fn()}));
const id="11111111-1111-4111-8111-111111111111";
const input={sessionId:id,provider:"codex",cwd:"/work",createdAt:"2026-11-16T00:00:00Z",turnNumber:2,codexMarkerRequired:true};
const prior=()=>({sessionId:id,provider:"codex",turnNumber:2,turns:[],nativeSourceAvailable:true,nativeSourceStatus:"available" as const,
 nativeActivity:"idle" as const,nativeSessionId:"native",activityVersion:"offset:1",nativeActivityEvidence:{id:"end:1",kind:"task_complete"}});
let root:string,store:ThreadTranscriptStore,bindings:CodexConversationBindingStore;
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),"native-ready-"));bindings=new CodexConversationBindingStore(root);
 await bindings.record({sessionId:id,nativeSessionId:"native",cwd:"/work",transcriptPath:"/rollout"});
 store=new ThreadTranscriptStore(root,{codexConversations:bindings,codexRemoteHome:"/private/native"});
 vi.mocked(readCodexRemoteIdle).mockReset().mockResolvedValue(true);
 vi.spyOn(store,"observeProviderTurns").mockResolvedValue(prior());
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe("runtime idle and transcript reconciliation",()=>{
 it("attaches admission evidence only after rereading the same native source",async()=>{
  const result=await store.refreshNativeReadiness(input,prior());
  expect(result?.nativeReadiness?.nativeSessionId).toBe("native");expect(result?.turns).toEqual([]);
  expect(readCodexRemoteIdle).toHaveBeenCalledWith({homeDirectory:"/private/native",nativeSessionId:"native",cwd:"/work",transcriptPath:"/rollout"});
 });
 it("does not probe unmarked launches",async()=>{expect(await store.refreshNativeReadiness({...input,codexMarkerRequired:false},prior())).toBeUndefined();expect(readCodexRemoteIdle).not.toHaveBeenCalled();});
 it("refuses unavailable runtime status",async()=>{vi.mocked(readCodexRemoteIdle).mockResolvedValue(false);expect(await store.refreshNativeReadiness(input,prior())).toBeUndefined();expect(store.observeProviderTurns).not.toHaveBeenCalled();});
 it.each(["version","identity","working","unavailable","boundary"])("refuses changed %s after the runtime read",async change=>{
  const next:any=prior();if(change==="version")next.activityVersion="offset:2";if(change==="identity")next.nativeSessionId="other";
  if(change==="working")next.nativeActivity="working";if(change==="unavailable")next.nativeSourceAvailable=false;if(change==="boundary")next.nativeSourceReason="NATIVE_COMPLETION_BOUNDARY_MISSING";
  vi.mocked(store.observeProviderTurns).mockResolvedValue(next);expect(await store.refreshNativeReadiness(input,prior())).toBeUndefined();
 });
 it("refuses a binding replaced during the runtime read",async()=>{
  vi.mocked(readCodexRemoteIdle).mockImplementation(async()=>{await bindings.record({sessionId:id,nativeSessionId:"other",cwd:"/work",transcriptPath:"/other"});return true;});
  expect(await store.refreshNativeReadiness(input,prior())).toBeUndefined();
 });
});
