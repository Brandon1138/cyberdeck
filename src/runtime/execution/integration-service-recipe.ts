import { createHash } from "node:crypto";
import { z } from "zod";
import { ExecutionIdentitySchema } from "../../domain/worker-execution.js";

export const IntegrationServiceRequestSchema = z.object({
  identity: ExecutionIdentitySchema.strict(), attemptId: z.uuid(),
  leaseVersion: z.number().int().positive(), recipe: z.literal("postgres-fixture-v1"),
}).strict();
export type IntegrationServiceRequest = z.infer<typeof IntegrationServiceRequestSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const integrationHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** The caller chooses a recipe, never an image, command, mount, network or environment. */
export function integrationRecipe(image: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("INTEGRATION_IMAGE_NOT_PINNED");
  return {
    id: "postgres-fixture-v1" as const, version: "1", image,
    service: { memoryBytes: 384 * 1024 ** 2, cpus: 0.5, pids: 96 },
    runner: { memoryBytes: 128 * 1024 ** 2, cpus: 0.5, pids: 32 },
    // Named tmpfs volume has no persistent host data and an enforced size ceiling.
    dataBytes: 128 * 1024 ** 2, tmpBytes: 16 * 1024 ** 2,
    readinessMs: 60_000, testMs: 30_000, port: 5432,
    sql: "BEGIN; CREATE TABLE capability_fixture (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO capability_fixture VALUES (1, 'isolated-service'); DO $$ BEGIN IF (SELECT value FROM capability_fixture WHERE id = 1) <> 'isolated-service' THEN RAISE EXCEPTION 'fixture mismatch'; END IF; END $$; ROLLBACK; DO $$ BEGIN IF to_regclass('capability_fixture') IS NOT NULL THEN RAISE EXCEPTION 'rollback mismatch'; END IF; END $$; SELECT 'cyberdeck-integration-pass';",
  };
}
export type IntegrationRecipe = ReturnType<typeof integrationRecipe>;
export function integrationNames(request: IntegrationServiceRequest) {
  const key = integrationHash(request);
  const prefix = `cyberdeck-service-${key.slice(0, 32)}`;
  return { key, network: `${prefix}-net`, volume: `${prefix}-data`, service: `${prefix}-db`, runner: `${prefix}-test` };
}
export function integrationLabels(request: IntegrationServiceRequest, recipeHash: string) {
  return {
    "cyberdeck.broker": request.identity.brokerId, "cyberdeck.execution": request.identity.executionId,
    "cyberdeck.worker": request.identity.workerId, "cyberdeck.generation": String(request.identity.generation),
    "cyberdeck.attempt": request.attemptId, "cyberdeck.lease-version": String(request.leaseVersion),
    "cyberdeck.service-recipe": recipeHash, "cyberdeck.service-run": integrationNames(request).key,
  };
}
export function serviceContainerArgs(input: {
  request: IntegrationServiceRequest; recipe: IntegrationRecipe; password: string; runner: boolean;
}): string[] {
  const { request, recipe, password, runner } = input, names = integrationNames(request);
  const limits = runner ? recipe.runner : recipe.service;
  const labels = Object.entries(integrationLabels(request, integrationHash(recipe))).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const common = ["create", "--name", runner ? names.runner : names.service, ...labels,
    "--pull", "never", "--init", "--user", "postgres", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", String(limits.pids), "--cpus", String(limits.cpus), "--memory", String(limits.memoryBytes),
    "--memory-swap", String(limits.memoryBytes), "--network", names.network,
    "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
    "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${recipe.tmpBytes}`, "--shm-size", String(recipe.tmpBytes)];
  if (runner) return [...common, "--tmpfs", `/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=${recipe.tmpBytes}`, "--env", "PGHOST=database", "--env", "PGPORT=5432", "--env", "PGUSER=cyberdeck",
    "--env", "PGDATABASE=cyberdeck", "--env", `PGPASSWORD=${password}`, "--env", "PGCONNECT_TIMEOUT=5",
    "--entrypoint", "psql", recipe.image, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--command", recipe.sql];
  return [...common, "--network-alias", "database", "--mount", `type=volume,src=${names.volume},dst=/var/lib/postgresql/data,volume-nocopy`,
    "--tmpfs", `/var/run/postgresql:rw,nosuid,nodev,noexec,size=${recipe.tmpBytes},mode=1777`,
    "--env", "PGDATA=/var/lib/postgresql/data/pgdata", "--env", "POSTGRES_USER=cyberdeck", "--env", "POSTGRES_DB=cyberdeck",
    "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
    "--health-cmd", "pg_isready -h 127.0.0.1 -U cyberdeck -d cyberdeck", "--health-interval", "1s",
    "--health-timeout", "2s", "--health-retries", "60", recipe.image,
    "postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=16", "-c", "work_mem=1MB", "-c", "max_wal_size=32MB", "-c", "min_wal_size=32MB"];
}
