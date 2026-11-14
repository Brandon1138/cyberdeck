import { StrigoiPageIndex } from "./strigoi-page-index.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { STRIGOI_LIMITS, StrigoiArtifactRefSchema, StrigoiPacketSchema, StrigoiPacketRefSchema, StrigoiSourceRefSchema,
  type StrigoiArtifactRef, type StrigoiIdentity, type StrigoiPacketRef, type StrigoiSourceRef } from "../domain/strigoi.js";
import type { StrigoiPacketPort } from "../orchestration/strigoi-ports.js";
import type { ArtifactStore } from "./artifact-store.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const SourceSchema = StrigoiSourceRefSchema.refine((s) => s.copy !== undefined && s.coverageSourceId !== undefined
  && s.sessionIds !== undefined && s.part !== undefined && s.sha256 !== undefined && s.text === undefined, "Uncaptured source");
const PageSchema = z.object({ sources: z.array(SourceSchema).min(1).max(STRIGOI_LIMITS.sourceReferencesPerPage), next: StrigoiArtifactRefSchema.optional() }).strict();
const sourceKey = (s: StrigoiSourceRef) => digest(JSON.stringify([s.kind, s.id, s.revision, s.sha256, s.part]));

/** Linked inventories keep the entry manifest bounded regardless of total obligations. */
export class StrigoiPackets implements StrigoiPacketPort {
  private readonly index: StrigoiPageIndex;
  constructor(private readonly artifacts: ArtifactStore) {
    this.index = new StrigoiPageIndex((body) => this.put("strigoi-page-index", body), (ref) => this.get(ref));
  }
  async copy(ref: StrigoiSourceRef, text: string, sessionIds: string[]): Promise<StrigoiSourceRef[]> {
    const parsed = StrigoiSourceRefSchema.parse(ref), result: StrigoiSourceRef[] = [];
    const bytes = Buffer.from(text); let offset = 0;
    do {
      let end = Math.min(bytes.length, offset + STRIGOI_LIMITS.sourceTextBytesPerPage);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      const chunk = bytes.subarray(offset, end).toString("utf8");
      const copy = await this.put("strigoi-source", chunk);
      const source: StrigoiSourceRef = { kind: parsed.kind, id: parsed.id, revision: parsed.revision,
        sha256: digest(text), part: result.length, sessionIds: [...new Set(sessionIds)].sort(), copy };
      source.coverageSourceId = sourceKey(source); result.push(SourceSchema.parse(source)); offset = end;
    } while (offset < bytes.length);
    return result;
  }
  async verify(sources: StrigoiSourceRef[]): Promise<void> {
    const groups = new Map<string, StrigoiSourceRef[]>();
    for (const source of sources) {
      SourceSchema.parse(source);
      if (sourceKey(source) !== source.coverageSourceId) throw new Error("STRIGOI_SOURCE_CORRUPT");
      const key = JSON.stringify([source.kind, source.id, source.revision, source.sha256]);
      const group = groups.get(key) ?? []; group.push(source); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const hash = createHash("sha256");
      for (const [index, source] of group.sort((a, b) => a.part! - b.part!).entries()) {
        if (source.part !== index) throw new Error("STRIGOI_SOURCE_PART_MISSING");
        const text = await this.get(source.copy!);
        if (Buffer.byteLength(text) > STRIGOI_LIMITS.sourceTextBytesPerPage) throw new Error("STRIGOI_SOURCE_TOO_LARGE");
        hash.update(text);
      }
      if (hash.digest("hex") !== group[0]!.sha256) throw new Error("STRIGOI_SOURCE_CORRUPT");
    }
  }
  async write(author: StrigoiIdentity, prose: string, sources: StrigoiSourceRef[], createdAt: string): Promise<StrigoiPacketRef> {
    // Validate prose before performing any writes.
    const coverageId = randomUUID();
    StrigoiPacketSchema.parse({ schemaVersion: 1, author, prose, createdAt, coverageId, sourceCount: 0 });
    await this.verify(sources);
    const unique = new Map<string, StrigoiSourceRef>();
    for (const source of sources) { const parsed = SourceSchema.parse(source); if (sourceKey(parsed) !== parsed.coverageSourceId) throw new Error("STRIGOI_SOURCE_CORRUPT"); unique.set(parsed.coverageSourceId!, parsed); }
    const pages: StrigoiSourceRef[][] = []; let page: StrigoiSourceRef[] = [], bytes = 0;
    for (const source of unique.values()) {
      const text = await this.get(source.copy!);
      if (Buffer.byteLength(text) > STRIGOI_LIMITS.sourceTextBytesPerPage) throw new Error("STRIGOI_SOURCE_TOO_LARGE");
      if (page.length && (page.length === STRIGOI_LIMITS.sourceReferencesPerPage || bytes + Buffer.byteLength(text) > STRIGOI_LIMITS.sourceTextBytesPerPage)) {
        pages.push(page); page = []; bytes = 0;
      }
      page.push(source); bytes += Buffer.byteLength(text);
    }
    if (page.length) pages.push(page);
    const leaves = []; let offset = 0;
    for (const sources of pages) {
      leaves.push({ page: await this.put("strigoi-inventory", JSON.stringify(PageSchema.parse({ sources }))), offset });
      offset += sources.length;
    }
    const inventory = leaves.length ? await this.index.write(leaves) : undefined;
    const packet = StrigoiPacketSchema.parse({ schemaVersion: 2, author, prose, createdAt, coverageId, sourceCount: unique.size, inventory,
      ...(leaves.length ? { inventoryPages: leaves.length } : {}) });
    const body = JSON.stringify(packet);
    if (Buffer.byteLength(body) > STRIGOI_LIMITS.packetManifestBytes) throw new Error("STRIGOI_MANIFEST_TOO_LARGE");
    return { ...await this.put("strigoi-packet", body), coverageId };
  }
  async read(input: StrigoiPacketRef, cursor?: string) {
    const ref = StrigoiPacketRefSchema.parse(input), body = await this.get(ref);
    if (Buffer.byteLength(body) > STRIGOI_LIMITS.packetManifestBytes) throw new Error("STRIGOI_MANIFEST_TOO_LARGE");
    const packet = StrigoiPacketSchema.parse(JSON.parse(body));
    if (packet.coverageId !== ref.coverageId) throw new Error("STRIGOI_COVERAGE_MISMATCH");
    if (packet.schemaVersion === 2) {
      if (!packet.inventory) {
        if (cursor !== undefined) throw new Error("STRIGOI_INVALID_CURSOR");
        return { packet, sources: [] };
      }
      const access = await this.index.read(packet.inventory, packet.inventoryPages!, ref.sha256, cursor);
      const page = PageSchema.parse(JSON.parse(await this.get(access.ref)));
      if (page.next || access.offset + page.sources.length > packet.sourceCount
        || (access.last && access.offset + page.sources.length !== packet.sourceCount)) throw new Error("STRIGOI_INVENTORY_COUNT");
      return { packet, sources: await this.texts(page.sources), ...(access.nextCursor ? { nextCursor: access.nextCursor } : {}) };
    }
    // Legacy v1 ordinals remain readable without rewriting existing packets.
    // A cursor is a packet-bound ordinal, never a caller-selected artifact pointer.
    const prefix = `${ref.sha256}:`;
    if (cursor !== undefined && (!cursor.startsWith(prefix) || !/^(0|[1-9][0-9]*)$/.test(cursor.slice(prefix.length)))) throw new Error("STRIGOI_INVALID_CURSOR");
    const index = cursor === undefined ? 0 : Number(cursor.slice(prefix.length));
    if (!Number.isSafeInteger(index) || index > packet.sourceCount) throw new Error("STRIGOI_INVALID_CURSOR");
    let current = packet.inventory, count = 0;
    const seen = new Set<string>();
    for (let i = 0; current; i++) {
      if (seen.has(current.artifactId)) throw new Error("STRIGOI_INVENTORY_CYCLE"); seen.add(current.artifactId);
      const page = PageSchema.parse(JSON.parse(await this.get(current))); count += page.sources.length;
      if (count > packet.sourceCount || (!page.next && count !== packet.sourceCount)) throw new Error("STRIGOI_INVENTORY_COUNT");
      if (i === index) {
        return { packet, sources: await this.texts(page.sources), ...(page.next ? { nextCursor: `${prefix}${index + 1}` } : {}) };
      }
      current = page.next;
    }
    if (index !== 0 || packet.sourceCount !== 0) throw new Error("STRIGOI_INVALID_CURSOR");
    return { packet, sources: [] };
  }
  private async texts(refs: StrigoiSourceRef[]) {
    let bytes = 0; const sources = [];
    for (const source of refs) {
      if (sourceKey(source) !== source.coverageSourceId) throw new Error("STRIGOI_SOURCE_CORRUPT");
      const text = await this.get(source.copy!); bytes += Buffer.byteLength(text); sources.push({ ...source, text });
    }
    if (bytes > STRIGOI_LIMITS.sourceTextBytesPerPage) throw new Error("STRIGOI_SOURCE_TOO_LARGE");
    return sources;
  }
  private async put(logicalKind: string, content: string): Promise<StrigoiArtifactRef> {
    const stored = await this.artifacts.write({ name: `${logicalKind}.json`, logicalKind, mediaType: "application/json", content });
    return { artifactId: stored.descriptor.id, sha256: digest(content) };
  }
  private async get(ref: StrigoiArtifactRef): Promise<string> {
    const stored = await this.artifacts.read(ref.artifactId), text = stored.content.toString("utf8");
    if (digest(text) !== ref.sha256) throw new Error("STRIGOI_ARTIFACT_HASH_MISMATCH");
    return text;
  }
}
