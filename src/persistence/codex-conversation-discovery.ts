import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSourceStatus, CaptureWorkerTurns as CaptureProviderTurns } from "../orchestration/session/worker-turn-ports.js";
import { CodexConversationBindingStore, type CodexConversationBinding } from "./codex-conversation-bindings.js";
import { candidateDayDirectories, readCodexMetadata, codexLaunchMatches, codexLaunchFingerprint, ignoreMissing,
  type CodexLaunchIdentity } from "./thread-transcript-lines.js";
import { hasNativeRollouts } from "./native-source-observation.js";
import { JsonlOffsetReader } from "./jsonl-offset-reader.js";
import { codexSessionClaims } from "../providers/codex/native-session-identity.js";

interface CodexTranscriptResolution { path?: string; status: NativeSourceStatus; reason?: string }

const CODEX_SESSION_MATCH_WINDOW_MS = 30_000;

/** One exact binding path for source reads, with an additional first-brief gate for launch receipts. */
export class CodexConversationDiscovery {
  private readonly codexLaunchClaims = new Map<string, { reader: JsonlOffsetReader; claims: Set<string> }>();
  constructor(private readonly bindings: CodexConversationBindingStore) {}

  async resolve(input: CaptureProviderTurns, requestedIdentity: CodexLaunchIdentity | undefined,
    root: string): Promise<CodexTranscriptResolution> {
    const binding = await this.bindings.read(input.sessionId);
    const identity: CodexLaunchIdentity | undefined = requestedIdentity === undefined ? binding?.launchIdentity
      : requestedIdentity.id === binding?.launchIdentity?.id && requestedIdentity.text === undefined
        ? { ...binding.launchIdentity, ...requestedIdentity } : requestedIdentity;
    if (binding === undefined && await this.bindings.exists(input.sessionId)) {
      return this.refuse("source-error", "NATIVE_BINDING_INVALID");
    }
    if (binding !== undefined) {
      if (binding.cwd !== input.cwd) return this.refuse("conflict", "NATIVE_BINDING_CWD_CONFLICT");
      if (await stat(binding.transcriptPath).catch(ignoreMissing) === undefined) {
        return this.refuse("missing", "NATIVE_SOURCE_MISSING");
      }
      const metadata = await readCodexMetadata(binding.transcriptPath);
      if (metadata?.id !== binding.nativeSessionId || metadata.cwd !== input.cwd) {
        return this.refuse("conflict", "NATIVE_BINDING_CONFLICT");
      }
      const claimants = await this.bindings.claimants(binding.nativeSessionId);
      if (claimants.some((id) => id !== input.sessionId)) return this.refuse("conflict", "NATIVE_BINDING_MULTIPLE_CLAIMANTS");
      // A durable actor binding is source identity, but launch evidence still needs its own brief.
      if (identity !== undefined && !await codexLaunchMatches(binding.transcriptPath, identity)) {
        return this.refuse("unbound", "NATIVE_LAUNCH_IDENTITY_UNAVAILABLE");
      }
      const claims = await this.readCodexLaunchClaims(binding.transcriptPath);
      if (claims.size > 0 && (!claims.has(input.sessionId) || claims.size !== 1)) {
        return this.refuse("conflict", "NATIVE_BINDING_CONFLICT");
      }
      if (input.codexMarkerRequired && !claims.has(input.sessionId)) {
        return this.refuse("unbound", "NATIVE_CONVERSATION_UNBOUND");
      }
      if (claims.size === 0 && identity !== undefined
        && !(Math.abs(Date.parse(metadata.timestamp) - Date.parse(input.createdAt)) <= CODEX_SESSION_MATCH_WINDOW_MS)) {
        return this.refuse("unbound", "NATIVE_LAUNCH_IDENTITY_UNAVAILABLE");
      }
      if (identity === undefined || claims.size === 1 && claims.has(input.sessionId)) {
        return { status: "available", path: binding.transcriptPath };
      }
    }
    const createdAt = Date.parse(input.createdAt);
    const textHash = identity?.text === undefined ? identity?.textHash : codexLaunchFingerprint(identity.text);
    const launch = identity === undefined ? {} : { launchIdentity: { id: identity.id,
      ...(textHash === undefined ? {} : { textHash }) } };
    const candidates: CodexConversationBinding[] = binding === undefined ? [] : [{ ...binding, ...launch }];
    const owners = new Map<string, Set<string>>();
    if (binding !== undefined) owners.set(binding.nativeSessionId, new Set([input.sessionId]));
    let conflictingActorClaim = false;
    for (const directory of candidateDayDirectories(root, createdAt)) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const path = join(directory, entry.name);
        const metadata = await readCodexMetadata(path);
        if (metadata === undefined || metadata.cwd !== input.cwd) continue;
        const claims = await this.readCodexLaunchClaims(path);
        const nativeOwners = owners.get(metadata.id) ?? new Set<string>();
        for (const claim of claims) nativeOwners.add(claim);
        owners.set(metadata.id, nativeOwners);
        // Another actor's exact marker is proof this rollout is foreign, not an ambiguity.
        if (claims.size > 0 && !claims.has(input.sessionId)) continue;
        const launchMatches = identity !== undefined && await codexLaunchMatches(path, identity);
        // Preserve #148's narrow legacy rule. New launches must carry their own actor marker.
        if (!input.codexMarkerRequired && launchMatches && claims.size === 0
          && Math.abs(Date.parse(metadata.timestamp) - createdAt) <= CODEX_SESSION_MATCH_WINDOW_MS) {
          claims.add(input.sessionId);
          nativeOwners.add(input.sessionId);
        }
        if (claims.has(input.sessionId) && claims.size !== 1) conflictingActorClaim = true;
        if (claims.size === 1 && claims.has(input.sessionId)
          && (identity === undefined || launchMatches) && path !== binding?.transcriptPath) candidates.push({
          sessionId: input.sessionId, nativeSessionId: metadata.id, transcriptPath: path, cwd: metadata.cwd,
          ...launch,
        });
      }
    }
    if (candidates.length > 1 || conflictingActorClaim) {
      return this.refuse("conflict", "NATIVE_BINDING_AMBIGUOUS");
    }
    if (candidates.length === 0) return await hasNativeRollouts(root)
      ? this.refuse("unbound", "NATIVE_CONVERSATION_UNBOUND")
      : this.refuse("missing", "NATIVE_SOURCE_MISSING");
    const match = candidates[0]!;
    if (owners.get(match.nativeSessionId)?.size !== 1) return this.refuse("conflict", "NATIVE_BINDING_AMBIGUOUS");
    const claimants = await this.bindings.claimants(match.nativeSessionId);
    if (claimants.some((id) => id !== input.sessionId)) return this.refuse("conflict", "NATIVE_BINDING_MULTIPLE_CLAIMANTS");
    if (binding === undefined || JSON.stringify(binding.launchIdentity) !== JSON.stringify(match.launchIdentity)) {
      await this.bindings.record(match);
    }
    return { status: "available", path: match.transcriptPath };
  }

  private refuse(status: NativeSourceStatus, reason: string): CodexTranscriptResolution {
    return { status, reason };
  }

  private async readCodexLaunchClaims(path: string): Promise<Set<string>> {
    let cached = this.codexLaunchClaims.get(path);
    if (cached === undefined) {
      const claims = new Set<string>();
      cached = { claims, reader: new JsonlOffsetReader(() => claims.clear()) };
      this.codexLaunchClaims.set(path, cached);
    }
    // This is only discovery acceleration. Durable identity, not cache order, owns attribution.
    while (this.codexLaunchClaims.size > 256) this.codexLaunchClaims.delete(this.codexLaunchClaims.keys().next().value!);
    const value = cached;
    await value.reader.scan(path, (line) => { for (const claim of codexSessionClaims(line)) value.claims.add(claim); });
    return new Set(value.claims);
  }
}
