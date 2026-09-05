import { execFile, type ExecFileOptions } from "node:child_process";
import { CANONICAL_PROVIDER_IDS } from "../domain/provider-registration.js";
import { ReasoningEffortSchema, type ProviderId, type ReasoningEffort } from "../domain/session.js";
import {
  WORKER_PROVIDER_CAPABILITIES,
  type ResolvedWorkerCapability,
} from "./worker-capabilities.js";

/**
 * Run a listing command and read what it printed.
 *
 * Standard input is closed immediately. `agy models` prints its listing and then waits on an open
 * stdin pipe forever, so a probe that leaves one attached does not read a listing — it times out and
 * reports the provider unaskable, which is a wrong answer written confidently.
 */
export function runListingCommand(
  executable: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [...args], options, (error, stdout) => {
      if (error === null) resolve({ stdout: stdout.toString() });
      else reject(error);
    });
    child.stdin?.end();
  });
}

/** What one provider answered when asked what it currently offers. */
export type ProviderModelListing =
  | { models: readonly ProviderModel[] }
  /** The provider was not asked, or could not answer. The reason is quoted to every reader. */
  | { unavailable: string };

export interface ProviderModel {
  id: string;
  /** The provider's own display name for this id, when its listing printed one. */
  label?: string;
  /**
   * The efforts this id alone accepts, when the provider's listing named them per model.
   *
   * A provider that prints one effort range for one model has answered a question the static
   * catalog can only answer as a snapshot: `codex debug models` gives gpt-5.3-codex-spark
   * low..xhigh while gpt-5.6-sol reaches ultra. Absent here means unconstrained, not empty.
   */
  efforts?: readonly ReasoningEffort[];
}

export interface ProviderModelProbe {
  list(provider: ProviderId): Promise<ProviderModelListing>;
}

/**
 * The provider CLIs that advertise a model listing, and the exact command that prints it.
 *
 * Only commands observed printing a listing appear here. A provider absent from this table is not
 * a provider with no models — it is a provider Cyberdeck has no read-only way to ask, which is why
 * its absence produces a named fallback rather than an empty list. Adding one is a row here.
 */
export type ProviderListingFormat = "labelled-lines" | "codex-json";

export const PROVIDER_MODEL_LISTING_COMMANDS: Partial<
  Record<ProviderId, { executable: string; args: readonly string[]; format: ProviderListingFormat }>
> = {
  // `agent models` printed `<id> - <label>` lines under an "Available models" header, 2026-08-16.
  cursor: { executable: "agent", args: ["models"], format: "labelled-lines" },
  // `agy models` printed tab-separated `<id>\t<label>` lines after a progress line, 2026-08-16.
  antigravity: { executable: "agy", args: ["models"], format: "labelled-lines" },
  // `codex debug models` printed a JSON catalog naming each model's own effort range, 2026-08-20.
  // Its own format, read by its own parser: the line parser must not be widened to guess at JSON.
  codex: { executable: "codex", args: ["debug", "models"], format: "codex-json" },
};

/** Why a provider with no row above is never queried. Quoted verbatim as the fallback reason. */
const NO_LISTING_COMMAND: Partial<Record<ProviderId, string>> = {
  claude: "the claude CLI advertises no model-listing subcommand, so its models cannot be observed",
};

/**
 * A model id as a provider prints it.
 *
 * Deliberately permissive about what a slug may contain and strict about what it may not: an id
 * with whitespace, a leading dash, or shell metacharacters is prose the parser misread, not a
 * launch identifier, and it must never reach argv.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/**
 * Reads what each provider CLI says it currently offers.
 *
 * Every command is a fixed argument list run with no shell. The listings are read-only — printing a
 * listing selects nothing — and a failure is answered with a reason rather than an exception,
 * because "this provider could not be asked" is an answer Fleet and an orchestrator both have to be
 * able to render.
 */
export class CliProviderModelProbe implements ProviderModelProbe {
  constructor(private readonly timeoutMs = 10_000) {}

  async list(provider: ProviderId): Promise<ProviderModelListing> {
    const command = PROVIDER_MODEL_LISTING_COMMANDS[provider];
    if (command === undefined) {
      return {
        unavailable: NO_LISTING_COMMAND[provider]
          ?? `no model-listing command is registered for ${provider}`,
      };
    }
    let stdout: string;
    try {
      ({ stdout } = await runListingCommand(command.executable, command.args, {
        timeout: this.timeoutMs,
        // `codex debug models` printed 355KB on 2026-08-20 — every model embeds its full
        // instruction template — and a listing truncated at the buffer is a parse failure that
        // would read as "this provider offers nothing".
        maxBuffer: 8 * 1024 * 1024,
        // The listing is a fact about the installed CLI, not about any repository, so it is read
        // from a directory no worker owns.
        cwd: "/",
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        unavailable: `${command.executable} ${command.args.join(" ")} failed: ${message}`,
      };
    }
    const models = command.format === "codex-json"
      ? parseCodexModelCatalog(stdout)
      : parseModelListing(stdout);
    return models.length === 0
      ? {
        unavailable: `${command.executable} ${command.args.join(" ")} printed no recognizable model ids`,
      }
      : { models };
  }
}

/**
 * One line of a provider listing.
 *
 * Both observed formats are `<id><separator><label>`, separated by a tab or by ` - `. A line whose
 * first token is not a model id — a header, a tip, a progress line — contributes nothing, and a
 * listing that contributes nothing at all is reported unavailable rather than served as empty.
 */
export function parseModelListing(output: string): ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const tabbed = line.indexOf("\t");
    const dashed = line.indexOf(" - ");
    const [id, label] = tabbed !== -1
      ? [line.slice(0, tabbed), line.slice(tabbed + 1)]
      : dashed !== -1
        ? [line.slice(0, dashed), line.slice(dashed + 3)]
        : [line, ""];
    const trimmedId = id.trim();
    if (!MODEL_ID.test(trimmedId) || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    const trimmedLabel = label.trim();
    models.push({ id: trimmedId, ...(trimmedLabel === "" ? {} : { label: trimmedLabel }) });
  }
  return models;
}

/**
 * The JSON catalog `codex debug models` prints.
 *
 * Read strictly, and only for what a launch needs: the slug, the display name, and the effort
 * range that slug alone accepts. Two things the catalog carries are deliberately dropped. Entries
 * marked `visibility: "hide"` — `codex-auto-review`, `gpt-reserve` on 2026-08-20 — are the CLI's
 * own internal models, and offering one in Fleet's composer advertises a launch the provider does
 * not mean to sell. And a reasoning level the ReasoningEffort contract does not name is a rung
 * Cyberdeck has no way to pass, so it is dropped rather than widening the contract by parse.
 *
 * Malformed JSON, a missing `models` array, or an entry list that yields nothing recognizable all
 * return empty, which the caller reports as unavailable — the stored catalog stands in, and no
 * reader is ever served an empty model list as though codex offered nothing.
 */
export function parseCodexModelCatalog(output: string): ProviderModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const entries = (parsed as { models?: unknown }).models;
  if (!Array.isArray(entries)) return [];

  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["visibility"] !== "list") continue;
    const slug = typeof record["slug"] === "string" ? record["slug"].trim() : "";
    if (!MODEL_ID.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const displayName = typeof record["display_name"] === "string" ? record["display_name"].trim() : "";
    const efforts = codexReasoningEfforts(record["supported_reasoning_levels"]);
    models.push({
      id: slug,
      ...(displayName === "" ? {} : { label: displayName }),
      // Empty or unknown levels do not authorize the provider's whole effort range.
      efforts,
    });
  }
  return models;
}

/** The `supported_reasoning_levels` entries that name an effort Cyberdeck can actually launch. */
function codexReasoningEfforts(levels: unknown): readonly ReasoningEffort[] {
  if (!Array.isArray(levels)) return [];
  const efforts: ReasoningEffort[] = [];
  for (const level of levels) {
    if (typeof level !== "object" || level === null) continue;
    const parsed = ReasoningEffortSchema.safeParse((level as { effort?: unknown }).effort);
    if (parsed.success && !efforts.includes(parsed.data)) efforts.push(parsed.data);
  }
  return efforts;
}

export interface WorkerCapabilityCatalogOptions {
  probe?: ProviderModelProbe;
  /** How long a provider's answer stands before it is asked again. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * The one place that decides what models a worker may be launched with.
 *
 * Fleet's composer, the `cyberdeck_provider_capabilities` tool, and the launch boundary all read
 * this, so none of them can be offering, advertising, or accepting a different set than the others.
 * What it serves is the provider's own listing where a provider can be asked, and the static
 * catalog — carrying `source: "fallback-catalog"` and the reason — where it cannot.
 *
 * Effort values, approval modes, id rules, and grant notes are Cyberdeck's launch contract rather
 * than facts a listing reports, so they are kept from the static entry either way. Only the model
 * set and its labels come from the provider.
 */
export class WorkerCapabilityCatalog {
  private readonly probe: ProviderModelProbe;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: { resolvedAtMs: number; capabilities: readonly ResolvedWorkerCapability[] } | undefined;
  private inFlight: Promise<readonly ResolvedWorkerCapability[]> | undefined;

  constructor(options: WorkerCapabilityCatalogOptions = {}) {
    this.probe = options.probe ?? new CliProviderModelProbe();
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async resolve(provider?: string): Promise<ResolvedWorkerCapability[]> {
    const capabilities = await this.resolveAll();
    return capabilities
      .filter((entry) => provider === undefined || entry.provider === provider)
      .map((entry) => ({ ...entry }));
  }

  /** Drops the cache so the next read asks every provider again. */
  invalidate(): void {
    this.cache = undefined;
  }

  private async resolveAll(): Promise<readonly ResolvedWorkerCapability[]> {
    const cached = this.cache;
    if (cached !== undefined && this.now() - cached.resolvedAtMs < this.ttlMs) return cached.capabilities;
    // A second caller during a probe waits for the first answer instead of spawning the CLIs again.
    this.inFlight ??= this.probeAll().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async probeAll(): Promise<readonly ResolvedWorkerCapability[]> {
    const observedAt = new Date(this.now()).toISOString();
    const capabilities = await Promise.all(
      CANONICAL_PROVIDER_IDS.map(async (provider): Promise<ResolvedWorkerCapability> => {
        const declared = WORKER_PROVIDER_CAPABILITIES.find((entry) => entry.provider === provider);
        // A provider with no static entry has no launch contract to serve models under; saying so
        // is better than inventing efforts and approval modes for it.
        if (declared === undefined) {
          return {
            provider,
            models: [],
            efforts: [],
            approvalModes: [],
            modelIdRule: `${provider} has no declared worker launch contract`,
            notes: [],
            source: "fallback-catalog",
            fallbackReason: `${provider} declares no worker capability entry`,
          };
        }
        const listing = await this.probe.list(provider).catch((error: unknown) => ({
          unavailable: error instanceof Error ? error.message : String(error),
        }));
        if ("unavailable" in listing) {
          return { ...declared, source: "fallback-catalog", fallbackReason: listing.unavailable };
        }
        const modelLabels: Record<string, string> = {};
        const modelEfforts: Record<string, readonly ReasoningEffort[]> = {};
        for (const model of listing.models) {
          if (model.label !== undefined) modelLabels[model.id] = model.label;
          if (model.efforts !== undefined) modelEfforts[model.id] = model.efforts;
        }
        // The static entry's own per-model labels and efforts are a dated snapshot of this very
        // listing, so a live answer replaces them rather than merging with them: a model the
        // provider has since dropped must not keep constraining the list that replaced it.
        const { modelLabels: snapshotLabels, modelEfforts: snapshotEfforts, ...contract } = declared;
        void snapshotLabels;
        void snapshotEfforts;
        return {
          ...contract,
          models: listing.models.map((model) => model.id),
          ...(Object.keys(modelLabels).length === 0 ? {} : { modelLabels }),
          ...(Object.keys(modelEfforts).length === 0 ? {} : { modelEfforts }),
          source: "provider-query",
          observedAt,
        };
      }),
    );
    this.cache = { resolvedAtMs: this.now(), capabilities };
    return capabilities;
  }
}
