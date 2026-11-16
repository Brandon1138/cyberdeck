import { describe, expect, it, vi } from "vitest";
import { StrigoiLifecycle } from "../../src/orchestration/strigoi-lifecycle.js";

describe("resident reconciliation wake coalescing",()=>{
 it.each([false,true])("retains a wake received while the durable read is pending (dispose=%s)",async dispose=>{
  let resolve!:(state:unknown)=>void;
  const first=new Promise(r=>{resolve=r;});
  const read=vi.fn().mockReturnValueOnce(first).mockResolvedValue({desired:"suspended"});
  const lifecycle=new StrigoiLifecycle({repository:{read}} as any);
  const initial=lifecycle.reconcile();
  const wake=lifecycle.reconcile();
  expect(read).toHaveBeenCalledTimes(1);
  if(dispose)lifecycle.dispose();
  const readsBeforeRelease=read.mock.calls.length;
  resolve({desired:"suspended"});
  await Promise.all([initial,wake]);
  expect(read).toHaveBeenCalledTimes(readsBeforeRelease+(dispose?0:1));
  lifecycle.dispose();
 });
});
