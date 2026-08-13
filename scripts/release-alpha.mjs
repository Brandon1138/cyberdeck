#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "Brandon1138/cyberdeck";
const PACKAGE_NAME = "@ishmael38/cyberdeck";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_FILES = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
];

function fail(message) {
  throw new Error(message);
}

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
  const label = commandLabel(command, args);
  if (options.quiet !== true) process.stdout.write(`\n$ ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: options.capture === true ? "pipe" : "inherit",
  });
  if (result.error !== undefined) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${label} exited ${result.status}${detail === "" ? "" : `\n${detail}`}`);
  }
  return (result.stdout ?? "").trim();
}

function capture(command, args) {
  return run(command, args, { capture: true, quiet: true });
}

function replaceExactly(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) fail(`${label}: expected text was not found`);
  if (source.indexOf(before, first + before.length) !== -1) {
    fail(`${label}: expected text occurs more than once`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function nextAlphaVersion(currentVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/u.exec(currentVersion);
  if (match === null) fail(`Expected an alpha version, got ${currentVersion}`);
  return `${match[1]}.${match[2]}.${match[3]}-alpha.${Number(match[4]) + 1}`;
}

export function assertNextAlphaVersion(currentVersion, targetVersion) {
  const expected = nextAlphaVersion(currentVersion);
  if (targetVersion !== expected) {
    fail(`Alpha releases must be sequential: expected ${expected}, got ${targetVersion}`);
  }
}

export function localReleaseDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function updateReleaseDocuments(files, currentVersion, targetVersion, date) {
  const packageMetadata = JSON.parse(files["package.json"]);
  if (packageMetadata.name !== PACKAGE_NAME) {
    fail(`Refusing to release unexpected package ${String(packageMetadata.name)}`);
  }
  if (packageMetadata.version !== currentVersion) {
    fail(`package.json is ${String(packageMetadata.version)}, expected ${currentVersion}`);
  }
  packageMetadata.version = targetVersion;

  const readme = replaceExactly(
    files["README.md"],
    `\`${currentVersion}\` is a macOS developer preview`,
    `\`${targetVersion}\` is a macOS developer preview`,
    "README.md",
  );
  const issueTemplate = replaceExactly(
    files[".github/ISSUE_TEMPLATE/bug_report.yml"],
    `placeholder: ${currentVersion}`,
    `placeholder: ${targetVersion}`,
    ".github/ISSUE_TEMPLATE/bug_report.yml",
  );

  let changelog = replaceExactly(
    files["CHANGELOG.md"],
    "## [Unreleased]\n",
    `## [Unreleased]\n\n## [${targetVersion}] - ${date}\n`,
    "CHANGELOG.md heading",
  );
  changelog = replaceExactly(
    changelog,
    `[Unreleased]: https://github.com/${REPOSITORY}/compare/v${currentVersion}...HEAD`,
    `[Unreleased]: https://github.com/${REPOSITORY}/compare/v${targetVersion}...HEAD\n[${targetVersion}]: https://github.com/${REPOSITORY}/compare/v${currentVersion}...v${targetVersion}`,
    "CHANGELOG.md links",
  );

  return {
    "package.json": `${JSON.stringify(packageMetadata, null, 2)}\n`,
    "README.md": readme,
    "CHANGELOG.md": changelog,
    ".github/ISSUE_TEMPLATE/bug_report.yml": issueTemplate,
  };
}

export function assertPackFiles(paths) {
  const names = new Set(paths);
  for (const required of ["package.json", "LICENSE", "README.md", "dist/src/cli.js"]) {
    if (!names.has(required)) fail(`Packed artifact is missing ${required}`);
  }
  const forbidden = paths.find((path) =>
    path === "nvim.log" || path.startsWith("tests/") || path.startsWith("docs/prompts/"));
  if (forbidden !== undefined) fail(`Packed artifact contains development-only file ${forbidden}`);
}

function readReleaseFiles() {
  return Object.fromEntries(RELEASE_FILES.map((path) => [path, readFileSync(join(REPO_ROOT, path), "utf8")]));
}

function writeReleaseFiles(files) {
  for (const path of RELEASE_FILES) writeFileSync(join(REPO_ROOT, path), files[path]);
}

function parseJson(command, args) {
  const output = capture(command, args);
  try {
    return JSON.parse(output);
  } catch {
    fail(`${commandLabel(command, args)} returned invalid JSON:\n${output}`);
  }
}

function assertCleanMain() {
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main") fail(`Release must run from main, not ${branch || "detached HEAD"}`);
  const status = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") fail(`Release requires a clean checkout:\n${status}`);
}

function aheadBehind() {
  const value = capture("git", ["rev-list", "--left-right", "--count", "main...origin/main"]);
  const [ahead, behind] = value.split(/\s+/u).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) fail(`Invalid ahead/behind result: ${value}`);
  return { ahead, behind };
}

function assertParity() {
  const { ahead, behind } = aheadBehind();
  if (ahead !== 0 || behind !== 0) fail(`main must equal origin/main; found ${ahead} ahead, ${behind} behind`);
}

function registryState() {
  const result = parseJson("npm", ["view", PACKAGE_NAME, "versions", "dist-tags", "--json"]);
  const versions = Array.isArray(result.versions) ? result.versions : [result.versions].filter(Boolean);
  return { versions, distTags: result["dist-tags"] ?? {} };
}

function packageVersion() {
  const metadata = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (metadata.name !== PACKAGE_NAME) fail(`Refusing to release ${String(metadata.name)}`);
  return metadata.version;
}

function assertTagAbsent(tag) {
  const local = capture("git", ["tag", "--list", tag]);
  if (local !== "") fail(`Tag ${tag} already exists; inspect the existing release before retrying`);
}

function assertOnlyReleaseFilesChanged() {
  const changed = capture("git", ["diff", "--name-only"]).split("\n").filter(Boolean).sort();
  const expected = [...RELEASE_FILES].sort();
  if (JSON.stringify(changed) !== JSON.stringify(expected)) {
    fail(`Unexpected release diff. Expected ${expected.join(", ")}; got ${changed.join(", ")}`);
  }
  run("git", ["diff", "--check"]);
}

function verifyPackedCli(targetVersion) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "cyberdeck-release-"));
  try {
    const pack = parseJson("npm", [
      "pack", "--ignore-scripts", "--json", "--silent", "--pack-destination", temporaryRoot,
    ]);
    const result = pack[0];
    if (result === undefined || !Array.isArray(result.files)) fail("npm pack returned no package result");
    assertPackFiles(result.files.map(({ path }) => path));
    const packagePath = join(temporaryRoot, result.filename);
    const installRoot = join(temporaryRoot, "install");
    run("npm", ["install", "--global", "--prefix", installRoot, packagePath]);
    const installedVersion = capture(join(installRoot, "bin", "cyberdeck"), ["--version"]);
    if (installedVersion !== targetVersion) {
      fail(`Packed CLI reported ${installedVersion}, expected ${targetVersion}`);
    }
    process.stdout.write(`Packed ${result.filename} with ${result.files.length} files; CLI reports ${installedVersion}.\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function findWorkflowRun(workflow, headSha, headBranch, event) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const runs = parseJson("gh", [
      "run", "list", "--workflow", workflow, "--commit", headSha, "--event", event,
      "--limit", "20", "--json", "databaseId,status,conclusion,url,headBranch,headSha",
    ]);
    const match = runs.find((run) => run.headSha === headSha && run.headBranch === headBranch);
    if (match !== undefined) return match;
    if (attempt < 30) await delay(2000);
  }
  fail(`Timed out waiting for ${workflow} on ${headBranch} at ${headSha}`);
}

async function waitForWorkflow(workflow, headSha, headBranch, event) {
  const runRecord = await findWorkflowRun(workflow, headSha, headBranch, event);
  run("gh", ["run", "watch", String(runRecord.databaseId), "--exit-status"]);
  return runRecord.url;
}

async function waitForRegistry(targetVersion) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const state = registryState();
    if (state.versions.includes(targetVersion) && state.distTags.next === targetVersion) return state;
    if (attempt < 20) await delay(3000);
  }
  fail(`npm did not expose ${targetVersion} under next within 60 seconds`);
}

function verifyRemoteMain(commit) {
  const remote = capture("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/u)[0];
  if (remote !== commit) fail(`origin/main is ${remote}, expected ${commit}`);
}

function verifyRemoteTag(tag, commit) {
  const lines = capture("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const peeled = lines.split("\n").find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  if (peeled?.split(/\s+/u)[0] !== commit) fail(`Remote ${tag} does not peel to ${commit}`);
}

async function release() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) fail("Usage: pnpm release:alpha [target-version] [--dry-run]");

  assertCleanMain();
  run("git", ["fetch", "origin", "main", "--tags"]);
  assertParity();

  const currentVersion = packageVersion();
  const before = registryState();
  const currentPublished = before.versions.includes(currentVersion);
  const requestedVersion = positional[0];

  if (!currentPublished) {
    if (requestedVersion !== undefined && requestedVersion !== currentVersion) {
      fail(`${currentVersion} is committed but unpublished; resume it before ${requestedVersion}`);
    }
    fail(`${currentVersion} is committed but unpublished. Inspect its tag/workflow before retrying; automatic history repair is intentionally disabled.`);
  }

  const targetVersion = requestedVersion ?? nextAlphaVersion(currentVersion);
  assertNextAlphaVersion(currentVersion, targetVersion);
  const tag = `v${targetVersion}`;
  assertTagAbsent(tag);
  if (before.versions.includes(targetVersion)) fail(`${targetVersion} is already published`);

  process.stdout.write(`\nRelease plan: ${PACKAGE_NAME} ${currentVersion} -> ${targetVersion} under next.\n`);
  if (dryRun) return;

  const updated = updateReleaseDocuments(
    readReleaseFiles(), currentVersion, targetVersion, localReleaseDate(),
  );
  writeReleaseFiles(updated);
  assertOnlyReleaseFilesChanged();

  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["check"]);
  run("pnpm", ["test"]);
  run("pnpm", ["build"]);
  verifyPackedCli(targetVersion);

  run("git", ["add", ...RELEASE_FILES]);
  run("git", ["commit", "-m", `chore(release): ${targetVersion}`]);
  const commit = capture("git", ["rev-parse", "HEAD"]);

  run("git", ["fetch", "origin", "main"]);
  const divergence = aheadBehind();
  if (divergence.ahead !== 1 || divergence.behind !== 0) {
    fail(`origin/main changed during release; local is ${divergence.ahead} ahead, ${divergence.behind} behind`);
  }
  run("git", ["push", "origin", "main"]);
  verifyRemoteMain(commit);
  const ciUrl = await waitForWorkflow("ci.yml", commit, "main", "push");

  run("git", ["tag", "-a", tag, "-m", `Cyberdeck ${targetVersion}`]);
  run("git", ["push", "origin", tag]);
  verifyRemoteTag(tag, commit);
  const publishUrl = await waitForWorkflow("publish.yml", commit, tag, "push");

  const after = await waitForRegistry(targetVersion);
  if (after.distTags.latest !== before.distTags.latest) {
    fail(`latest moved from ${String(before.distTags.latest)} to ${String(after.distTags.latest)}`);
  }

  const installRoot = mkdtempSync(join(tmpdir(), "cyberdeck-npm-"));
  try {
    run("npm", ["install", "--global", "--prefix", installRoot, `${PACKAGE_NAME}@next`]);
    const installedVersion = capture(join(installRoot, "bin", "cyberdeck"), ["--version"]);
    if (installedVersion !== targetVersion) fail(`Published CLI reports ${installedVersion}`);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }

  assertCleanMain();
  assertParity();
  process.stdout.write([
    "",
    `Released ${PACKAGE_NAME}@${targetVersion}`,
    `commit: ${commit}`,
    `tag: ${tag}`,
    `CI: ${ciUrl}`,
    `publish: ${publishUrl}`,
    `dist-tags: ${JSON.stringify(after.distTags)}`,
    "",
  ].join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await release();
  } catch (error) {
    process.stderr.write(`\nrelease:alpha failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
