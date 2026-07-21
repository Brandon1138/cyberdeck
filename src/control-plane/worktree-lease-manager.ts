import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { CONTROL_PLANE_SCHEMA_VERSION, JobIdSchema, LeaseIdSchema } from "../domain/control-plane.js";
import { WorktreeLeaseSchema } from "../domain/lease.js";
import type { DurableLeaseRecord, LeaseStore } from "../persistence/lease-store.js";

export type LeaseAccess = "read-only" | "workspace-write";

export interface AcquireLeaseRequest {
  repositoryPath: string;
  worktreePath: string;
  access: LeaseAccess;
  holderJobId?: string;
  holderSessionId?: string;
  branch?: string;
  ttlMs?: number;
}

export interface LeaseGrant {
  lease: ReturnType<typeof WorktreeLeaseSchema.parse>;
  access: LeaseAccess;
  canonicalKey: string;
  fencingToken: number;
  ownerKey: string;
}

export interface RepositoryInspector {
  canonicalize(path: string): Promise<string>;
  isWorktreeDirty(path: string): Promise<boolean>;
}

export interface WorktreeLeaseManagerOptions {
  store: LeaseStore;
  repositoryInspector?: RepositoryInspector;
  now?: () => string;
  idFactory?: () => string;
  defaultTtlMs?: number;
}

export class WorktreeLeaseError extends Error {
  constructor(
    readonly code:
      | "LEASE_CONFLICT"
      | "LEASE_ORPHANED"
      | "LEASE_NOT_FOUND"
      | "STALE_LEASE"
      | "INVALID_OWNER"
      | "INVALID_TTL"
      | "DIRTY_WORKTREE",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeLeaseError";
  }
}

const defaultInspector: RepositoryInspector = {
  canonicalize: async (path) => realpath(resolve(path)),
  // The manager never deletes worktrees. The default remains fail-closed because no narrow Git
  // status port has been injected to prove cleanliness.
  isWorktreeDirty: async () => true,
};

/** Durable, canonical-path lease manager with per-target monotonic fencing tokens. */
export class WorktreeLeaseManager {
  private readonly records = new Map<string, DurableLeaseRecord>();
  private operation: Promise<void> = Promise.resolve();
  private readonly inspector: RepositoryInspector;

  constructor(private readonly options: WorktreeLeaseManagerOptions) {
    this.inspector = options.repositoryInspector ?? defaultInspector;
    const ttl = options.defaultTtlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new WorktreeLeaseError("INVALID_TTL", "defaultTtlMs must be positive");
  }

  async recover(): Promise<Array<{ leaseId: string; canonicalKey: string; ownerKey: string; manualRemediationRequired: true; guidance: string }>> {
    return this.serial(async () => {
      this.records.clear();
      for (const record of await this.options.store.load()) this.records.set(record.lease.leaseId, record);
      const evidence: Array<{ leaseId: string; canonicalKey: string; ownerKey: string; manualRemediationRequired: true; guidance: string }> = [];
      for (const record of [...this.records.values()]) {
        if (record.lease.state !== "held") continue;
        if (this.isExpired(record)) {
          await this.persistReleased(record, "expired during startup recovery");
          continue;
        }
        const orphaned = record.orphanedAt === undefined
          ? { ...record, orphanedAt: this.now(), orphanReason: "Broker restarted; prior lease owner is unverifiable" }
          : record;
        if (record.orphanedAt === undefined) {
          this.records.set(record.lease.leaseId, orphaned);
          await this.options.store.append(orphaned);
        }
        evidence.push({
          leaseId: orphaned.lease.leaseId,
          canonicalKey: orphaned.canonicalKey,
          ownerKey: orphaned.ownerKey,
          manualRemediationRequired: true,
          guidance: "Inspect the worktree and owner job; then explicitly resolve the orphan. Cyberdeck performs no Git cleanup.",
        });
      }
      return evidence;
    });
  }

  async acquire(request: AcquireLeaseRequest): Promise<LeaseGrant> {
    return this.serial(async () => {
      const owner = this.owner(request);
      const ttlMs = request.ttlMs ?? this.options.defaultTtlMs ?? 30_000;
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new WorktreeLeaseError("INVALID_TTL", "ttlMs must be positive");
      const canonicalRepositoryPath = await this.inspector.canonicalize(request.repositoryPath);
      const canonicalWorktreePath = await this.inspector.canonicalize(request.worktreePath);
      const canonicalKey = `${canonicalRepositoryPath}\0${canonicalWorktreePath}`;
      await this.expireKey(canonicalKey);
      const active = [...this.records.values()].filter(
        (record) => record.canonicalKey === canonicalKey && record.lease.state === "held",
      );
      if (active.some((record) => record.orphanedAt !== undefined)) {
        throw new WorktreeLeaseError("LEASE_ORPHANED", `Target ${canonicalKey} has unresolved orphaned ownership`);
      }
      if (
        active.some(
          (record) => request.access === "workspace-write" || record.access === "workspace-write",
        )
      ) {
        throw new WorktreeLeaseError("LEASE_CONFLICT", `Conflicting lease already holds ${canonicalKey}`);
      }
      const fencingToken = Math.max(0, ...[...this.records.values()].filter((record) => record.canonicalKey === canonicalKey).map((record) => record.fencingToken)) + 1;
      const now = this.now();
      const lease = WorktreeLeaseSchema.parse({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        leaseId: LeaseIdSchema.parse(this.options.idFactory?.() ?? randomUUID()),
        repositoryPath: canonicalRepositoryPath,
        worktreePath: canonicalWorktreePath,
        ...(request.branch !== undefined ? { branch: request.branch } : {}),
        ...(request.holderJobId !== undefined ? { holderJobId: JobIdSchema.parse(request.holderJobId) } : {}),
        ...(request.holderSessionId !== undefined ? { holderSessionId: request.holderSessionId } : {}),
        state: "held",
        acquiredAt: now,
        expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      });
      const record: DurableLeaseRecord = {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        lease,
        access: request.access,
        canonicalRepositoryPath,
        canonicalWorktreePath,
        canonicalKey,
        fencingToken,
        ownerKey: owner,
        lastRenewedAt: now,
      };
      await this.options.store.append(record);
      this.records.set(lease.leaseId, record);
      return this.grant(record);
    });
  }

  async renew(grant: LeaseGrant, ttlMs = this.options.defaultTtlMs ?? 30_000): Promise<LeaseGrant> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new WorktreeLeaseError("INVALID_TTL", "ttlMs must be positive");
      const record = this.requireCurrent(grant);
      if (record.orphanedAt !== undefined || this.isExpired(record)) {
        if (this.isExpired(record)) await this.persistReleased(record, "expired before renewal");
        throw new WorktreeLeaseError("STALE_LEASE", "Expired or orphaned lease cannot be renewed");
      }
      const now = this.now();
      const renewed: DurableLeaseRecord = {
        ...record,
        lease: { ...record.lease, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() },
        lastRenewedAt: now,
      };
      await this.options.store.append(renewed);
      this.records.set(renewed.lease.leaseId, renewed);
      return this.grant(renewed);
    });
  }

  async validate(grant: LeaseGrant): Promise<boolean> {
    return this.serial(async () => {
      const record = this.records.get(grant.lease.leaseId);
      if (record === undefined || !this.matches(record, grant) || record.lease.state !== "held" || record.orphanedAt !== undefined) return false;
      if (this.isExpired(record)) {
        await this.persistReleased(record, "expired during validation");
        return false;
      }
      const newestFence = Math.max(...[...this.records.values()].filter((candidate) => candidate.canonicalKey === record.canonicalKey).map((candidate) => candidate.fencingToken));
      return newestFence === record.fencingToken;
    });
  }

  async release(grant: LeaseGrant): Promise<LeaseGrant> {
    return this.serial(async () => {
      const record = this.records.get(grant.lease.leaseId);
      if (record === undefined || !this.matches(record, grant)) throw new WorktreeLeaseError("STALE_LEASE", "Lease owner or fence is stale");
      const newer = [...this.records.values()].some((candidate) => candidate.canonicalKey === record.canonicalKey && candidate.fencingToken > record.fencingToken);
      if (newer) throw new WorktreeLeaseError("STALE_LEASE", "A newer fencing token owns this target");
      if (record.lease.state === "released") return this.grant(record);
      return this.grant(await this.persistReleased(record, "released by current owner"));
    });
  }

  async resolveOrphan(grant: LeaseGrant, options: { operatorConfirmed: boolean }): Promise<LeaseGrant> {
    return this.serial(async () => {
      const record = this.requireCurrent(grant);
      if (record.orphanedAt === undefined) throw new WorktreeLeaseError("STALE_LEASE", "Lease is not orphaned");
      if (!options.operatorConfirmed) throw new WorktreeLeaseError("LEASE_ORPHANED", "Explicit operator confirmation is required");
      return this.grant(await this.persistReleased(record, "orphan manually resolved after operator verification"));
    });
  }

  async assessOrphanCleanup(grant: LeaseGrant): Promise<{ safeToDelete: false; dirty: boolean; guidance: string }> {
    const record = this.requireCurrent(grant);
    const dirty = await this.inspector.isWorktreeDirty(record.canonicalWorktreePath);
    return {
      safeToDelete: false,
      dirty,
      guidance: dirty
        ? "Worktree has user changes; refuse cleanup. Inspect and resolve manually."
        : "Cyberdeck does not delete worktrees automatically; operator verification and manual cleanup are required.",
    };
  }

  findByJob(jobId: string): LeaseGrant[] {
    return [...this.records.values()].filter((record) => record.lease.holderJobId === jobId && record.lease.state === "held").map((record) => this.grant(record));
  }

  findByOwner(ownerKey: string): LeaseGrant[] {
    return [...this.records.values()].filter((record) => record.ownerKey === ownerKey && record.lease.state === "held").map((record) => this.grant(record));
  }

  private owner(request: AcquireLeaseRequest): string {
    const count = Number(request.holderJobId !== undefined) + Number(request.holderSessionId !== undefined);
    if (count !== 1) throw new WorktreeLeaseError("INVALID_OWNER", "Exactly one job or session owner is required");
    return request.holderJobId !== undefined ? `job:${JobIdSchema.parse(request.holderJobId)}` : `session:${request.holderSessionId!}`;
  }

  private requireCurrent(grant: LeaseGrant): DurableLeaseRecord {
    const record = this.records.get(grant.lease.leaseId);
    if (record === undefined) throw new WorktreeLeaseError("LEASE_NOT_FOUND", `Unknown lease ${grant.lease.leaseId}`);
    if (!this.matches(record, grant)) throw new WorktreeLeaseError("STALE_LEASE", "Lease owner or fencing token is stale");
    return record;
  }

  private matches(record: DurableLeaseRecord, grant: LeaseGrant): boolean {
    return record.fencingToken === grant.fencingToken && record.ownerKey === grant.ownerKey && record.canonicalKey === grant.canonicalKey;
  }

  private isExpired(record: DurableLeaseRecord): boolean {
    return record.lease.expiresAt !== undefined && Date.parse(record.lease.expiresAt) <= Date.parse(this.now());
  }

  private async expireKey(canonicalKey: string): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.canonicalKey === canonicalKey && record.lease.state === "held" && this.isExpired(record)) {
        await this.persistReleased(record, "expired before acquisition");
      }
    }
  }

  private async persistReleased(record: DurableLeaseRecord, reason: string): Promise<DurableLeaseRecord> {
    if (record.lease.state === "released") return record;
    const released: DurableLeaseRecord = {
      ...record,
      lease: { ...record.lease, state: "released", releasedAt: this.now() },
      ...(record.orphanedAt !== undefined ? { orphanReason: reason } : {}),
    };
    await this.options.store.append(released);
    this.records.set(released.lease.leaseId, released);
    return released;
  }

  private grant(record: DurableLeaseRecord): LeaseGrant {
    return {
      lease: { ...record.lease },
      access: record.access,
      canonicalKey: record.canonicalKey,
      fencingToken: record.fencingToken,
      ownerKey: record.ownerKey,
    };
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
