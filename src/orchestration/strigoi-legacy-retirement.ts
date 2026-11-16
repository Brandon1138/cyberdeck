import { isLegacyHostPty, legacyRetirementFingerprint, legacyRetirementHash, LegacyRetirementProofSchema,
  LegacyRetirementRequestSchema, type LegacyRetirementProof, type LegacyRetirementRequest } from "../domain/strigoi-legacy-retirement.js";
import type { SessionRecord } from "../domain/session.js";
import type { StrigoiLifecycleOptions } from "./strigoi-lifecycle.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
/** Explicit operator maintenance. It records evidence only; resume remains a separate action. */
export class StrigoiLegacyRetirement {
  constructor(private readonly o: Pick<StrigoiLifecycleOptions, "repository" | "bindings" | "registry"> & {
    probe?: (record: SessionRecord) => Promise<LegacyRetirementProof>;
  }) {}
  private async candidate() {
    const state = await this.o.repository.read(), identity = state.transition?.successor;
    if (!identity || state.activeBinding?.sessionId !== identity.sessionId || state.incarnation !== identity.incarnation
      || state.activeGeneration !== identity.generation || !["committed", "adopting", "reconciling"].includes(state.transition!.phase))
      return fail("STRIGOI_LEGACY_TARGET_REQUIRED");
    const record = this.o.registry.get(identity.sessionId);
    if (!isLegacyHostPty(record) || record.generation !== identity.generation || this.o.registry.ownsProcess(record.id))
      return fail("STRIGOI_LEGACY_RUNTIME_NOT_RECONCILABLE");
    return { state, record };
  }
  async inspect() {
    const { state, record } = await this.candidate();
    if (!this.o.probe) return fail("STRIGOI_LEGACY_PROBE_UNAVAILABLE");
    const proof = LegacyRetirementProofSchema.parse(await this.o.probe(record));
    return { sessionId: record.id, generation: record.generation!, pid: record.pid,
      transitionId: state.transition!.id, expectedRevision: state.revision, recordSha256: legacyRetirementFingerprint(record),
      desired: state.desired, proof, requiresOperatorProvenanceConfirmation: true };
  }
  async confirm(input: LegacyRetirementRequest) {
    const request = LegacyRetirementRequestSchema.parse(input), requestHash = legacyRetirementHash(request);
    if (!this.o.bindings.withAuthority) return fail("STRIGOI_ATTENTION_AUTHORITY_REQUIRED");
    return this.o.bindings.withAuthority(async () => {
      const state = await this.o.repository.read();
      const prior = state.legacyRetirements?.find(r => r.request.mutationId === request.mutationId);
      if (prior) {
        if (prior.requestHash !== requestHash) return fail("STRIGOI_MUTATION_CONFLICT");
        await this.o.repository.confirmMutation(`legacy-retirement:${request.mutationId}`);
        return prior;
      }
      const before = await this.candidate();
      const validate = (value: typeof before) => {
        if (value.state.desired !== "suspended") return fail("STRIGOI_LEGACY_REQUIRES_SUSPENSION");
        if (value.state.revision !== request.expectedRevision || value.state.transition!.id !== request.transitionId
          || value.record.id !== request.sessionId || value.record.generation !== request.generation || value.record.pid !== request.pid
          || legacyRetirementFingerprint(value.record) !== request.recordSha256) return fail("STRIGOI_STALE_LEGACY_EVIDENCE");
      };
      validate(before);
      if (!this.o.probe) return fail("STRIGOI_LEGACY_PROBE_UNAVAILABLE");
      const proof = LegacyRetirementProofSchema.parse(await this.o.probe(before.record));
      if (proof.homeDirectory !== request.managedHome) return fail("STRIGOI_LEGACY_MANAGED_HOME_MISMATCH");
      const after = await this.candidate(); validate(after);
      const receipt = { request, requestHash, proof, contract: "operator-audited-node-pty-setsid" as const };
      await this.o.repository.compareAndSwap(after.state.revision, `legacy-retirement:${request.mutationId}`, {
        ...after.state, revision: after.state.revision + 1, updatedAt: proof.observedAt,
        legacyRetirements: [...after.state.legacyRetirements ?? [], receipt],
      });
      return receipt;
    });
  }
}
