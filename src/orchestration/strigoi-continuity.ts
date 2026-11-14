import { createHash } from "node:crypto";
import { StrigoiAdoptionSchema, StrigoiIdentitySchema, StrigoiSourceRefSchema,
  type StrigoiAdoption, type StrigoiIdentity, type StrigoiPacketRef, type StrigoiSourceRef, type StrigoiState } from "../domain/strigoi.js";
import type { StrigoiAdmissionPort, StrigoiRepository, StrigoiPacketPort, StrigoiSourcePort } from "./strigoi-ports.js";
import type { OrchestratorBindingLookup } from "./persistence-ports.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface StrigoiContinuityOptions {
  repository: StrigoiRepository; admission: StrigoiAdmissionPort;
  bindings: Pick<OrchestratorBindingLookup, "withAuthority">; packets: StrigoiPacketPort; sources: StrigoiSourcePort;
}
/** Records evidence, never drives model turns or changes controller/notification authority. */
export class StrigoiContinuity {
  constructor(private readonly options: StrigoiContinuityOptions) {}
  async checkpoint(identity: StrigoiIdentity, prose: string, sourceRefs: StrigoiSourceRef[], mutationId: string): Promise<StrigoiPacketRef> {
    const refs = sourceRefs.map((ref) => StrigoiSourceRefSchema.parse(ref));
    return this.options.admission.run(identity.sessionId, "mutate", async () => {
      const initial = await this.options.repository.read(); this.validateIdentity(initial, identity);
      const requestHash = hash({ identity, prose, refs });
      const prior = this.replay(initial, mutationId, requestHash);
      if (prior) return this.run(identity, "mutate", async (state) => {
        const receipt = this.replay(state, mutationId, requestHash)!;
        await this.options.repository.confirmMutation(mutationId); return receipt.packet;
      });
      // Native/transcript queues can acquire authority. Never wait for them while holding it.
      const sources = await this.options.sources.capture(initial);
      return this.run(identity, "mutate", async (state) => {
        const previous = this.replay(state, mutationId, requestHash);
        if (previous) { await this.options.repository.confirmMutation(mutationId); return previous.packet; }
        for (const ref of refs) {
          if (!sources.some((s) => s.kind === ref.kind && s.id === ref.id && s.revision === ref.revision
            && (ref.sha256 === undefined || s.sha256 === ref.sha256))) throw new Error("STRIGOI_UNKNOWN_SOURCE");
        }
        const packet = await this.options.packets.write(identity, prose, sources, new Date().toISOString());
        // Artifacts are durable before the canonical CAS references them. Caller refs consume nothing.
        await this.save(state, mutationId, { latestPacket: packet,
          continuityReceipts: [...state.continuityReceipts ?? [], { mutationId, requestHash, packet }] });
        return packet;
      });
    });
  }
  read(identity: StrigoiIdentity, packet: StrigoiPacketRef, cursor?: string) {
    return this.run(identity, "read", async (state) => {
      this.knownPacket(state, packet); return this.options.packets.read(packet, cursor);
    });
  }
  async acknowledge(input: StrigoiAdoption, mutationId: string): Promise<void> {
    const adoption = StrigoiAdoptionSchema.parse(input);
    return this.run(adoption.identity, "recovery", async (state) => {
      const requestHash = hash(adoption);
      if (this.replay(state, mutationId, requestHash)) { await this.options.repository.confirmMutation(mutationId); return; }
      const packet = [state.latestPacket, state.transition?.packet, ...state.continuityReceipts?.map((r) => r.packet) ?? []]
        .find((p) => p?.sha256 === adoption.packetHash && p.coverageId === adoption.coverageId);
      if (!packet) throw new Error("STRIGOI_UNKNOWN_COVERAGE");
      const captured = new Set<string>(); let cursor: string | undefined;
      do { const page = await this.options.packets.read(packet, cursor); page.sources.forEach((s) => captured.add(s.coverageSourceId!)); cursor = page.nextCursor; } while (cursor);
      if (adoption.handledSourceIds.some((id) => !captured.has(id))) throw new Error("STRIGOI_UNKNOWN_HANDLED_SOURCE");
      await this.save(state, mutationId, { continuityReceipts: [...state.continuityReceipts ?? [], { mutationId, requestHash, packet, adoption }] });
    });
  }
  /** Internal inventory for the recovery collaborator; no pending input is silently consumed. */
  pending(identity: StrigoiIdentity): Promise<StrigoiSourceRef[]> {
    return this.options.admission.run(identity.sessionId, "read", async () => {
      const initial = await this.options.repository.read(); this.validateIdentity(initial, identity);
      const sources = await this.options.sources.capture(initial);
      return this.run(identity, "read", async (state) => {
        const handled = new Set(state.continuityReceipts?.flatMap((r) => r.adoption?.handledSourceIds ?? []));
        return sources.filter((s) => !handled.has(s.coverageSourceId!));
      });
    });
  }
  private validateIdentity(state: StrigoiState, identity: StrigoiIdentity) {
    StrigoiIdentitySchema.parse(identity);
    if (state.activeBinding?.sessionId !== identity.sessionId || state.incarnation !== identity.incarnation || state.activeGeneration !== identity.generation) throw new Error("STRIGOI_STALE_INCARNATION");
  }

  private run<T>(identity: StrigoiIdentity, operation: "read" | "mutate" | "recovery", apply: (state: StrigoiState) => Promise<T>): Promise<T> {
    StrigoiIdentitySchema.parse(identity);
    return this.options.admission.run(identity.sessionId, operation, async () => {
      if (!this.options.bindings.withAuthority) throw new Error("AUTHORITY_UNAVAILABLE");
      return this.options.bindings.withAuthority(async () => {
        const state = await this.options.repository.read();
        this.validateIdentity(state, identity);
        if (operation !== "read" && state.desired !== "enabled") throw new Error("STRIGOI_SUSPENDED");
        return apply(state);
      });
    });
  }
  private knownPacket(state: StrigoiState, packet: StrigoiPacketRef): void {
    if (![state.latestPacket, state.transition?.packet, ...state.continuityReceipts?.map((r) => r.packet) ?? []]
      .some((p) => p?.artifactId === packet.artifactId && p.sha256 === packet.sha256 && p.coverageId === packet.coverageId)) throw new Error("STRIGOI_UNKNOWN_PACKET");
  }
  private replay(state: StrigoiState, mutationId: string, requestHash: string) {
    if (!mutationId.trim()) throw new Error("STRIGOI_INVALID_MUTATION");
    const receipt = state.continuityReceipts?.find((r) => r.mutationId === mutationId);
    if (receipt && receipt.requestHash !== requestHash) throw new Error("STRIGOI_MUTATION_CONFLICT");
    return receipt;
  }
  private save(state: StrigoiState, mutationId: string, patch: Partial<StrigoiState>) {
    return this.options.repository.compareAndSwap(state.revision, mutationId, { ...state, ...patch, revision: state.revision + 1, updatedAt: new Date().toISOString() });
  }
}
