import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResourceRuntimeBindingSchema, type ResourceRuntimeBinding, type ResourceRuntimeBindingPort } from "../domain/resource-runtime.js";

const Snapshot = z.object({ schemaVersion: z.literal(1), bindings: z.array(ResourceRuntimeBindingSchema).max(10000) }).strict();
/** Shares the installation owner's lifetime; a test broker cannot choose a second ownership scope. */
export class ResourceRuntimeBindingStore implements ResourceRuntimeBindingPort {
  private tail: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private constructor(private readonly directory: string, private readonly assertOwner: () => void,
    private bindings: ResourceRuntimeBinding[]) {}
  static async open(directory: string, assertOwner: () => void): Promise<ResourceRuntimeBindingStore> {
    assertOwner();
    let bindings: ResourceRuntimeBinding[] = [];
    try {
      const handle = await open(join(directory, "resource-runtimes.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size > 16 * 1024 ** 2) throw new Error("RESOURCE_BINDINGS_TOO_LARGE");
        bindings = Snapshot.parse(JSON.parse(await handle.readFile("utf8"))).bindings;
        if (new Set(bindings.map(b => b.request.requestId)).size !== bindings.length) throw new Error("RESOURCE_BINDING_DUPLICATE");
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new ResourceRuntimeBindingStore(directory, assertOwner, bindings);
  }
  list(): ResourceRuntimeBinding[] { this.assertOwner(); return structuredClone(this.bindings); }
  get(requestId: string): ResourceRuntimeBinding | undefined { return this.list().find(b => b.request.requestId === requestId); }
  put(input: ResourceRuntimeBinding): Promise<void> {
    const binding = ResourceRuntimeBindingSchema.parse(input);
    const result = this.tail.then(async () => {
      this.assertOwner();
      if (this.poisoned) throw new Error("RESOURCE_BINDINGS_UNAVAILABLE");
      const prior = this.get(binding.request.requestId);
      if (prior && JSON.stringify(prior.request) !== JSON.stringify(binding.request)) throw new Error("RESOURCE_BINDING_CONFLICT");
      const phases = ["queued", "reserved", "launching", "bound", "terminated"];
      if (prior && phases.indexOf(binding.phase) < phases.indexOf(prior.phase)) throw new Error("RESOURCE_BINDING_REGRESSION");
      if (prior && prior.identities.some(identity => !binding.identities.some(next => JSON.stringify(next) === JSON.stringify(identity))))
        throw new Error("RESOURCE_IDENTITY_FORGOTTEN");
      const bindings = [...this.bindings.filter(b => b.request.requestId !== binding.request.requestId), binding];
      const snapshot = Snapshot.parse({ schemaVersion: 1, bindings });
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized) > 16 * 1024 ** 2) throw new Error("RESOURCE_BINDINGS_TOO_LARGE");
      const path = join(this.directory, `resource-runtimes-${randomUUID()}.tmp`);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(serialized); await handle.sync();
        this.assertOwner();
        await rename(path, join(this.directory, "resource-runtimes.json"));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        this.bindings = bindings;
      } catch (error) { this.poisoned = true; throw error; }
      finally { await handle.close(); }
    });
    this.tail = result.catch(() => undefined); return result;
  }
}
