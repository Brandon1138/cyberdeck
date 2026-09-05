import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trustedGit } from "../../src/runtime/execution/trusted-git.js";
import { PrivateCloneProvisioner } from "../../src/runtime/execution/isolated-workspace.js";
import { contentHash, workspaceManifest } from "../../src/runtime/execution/workspace-manifest.js";
import { brokerFixture, eventually } from "./broker-fixture.js";

export async function dirtyTreeScenario(root: string) {
  const source = join(root, "source"); await mkdir(source);
  await trustedGit(source, ["init", "-b", "main"]);
  await trustedGit(source, ["config", "user.email", "eval@example.invalid"]);
  await trustedGit(source, ["config", "user.name", "Evaluation fixture"]);
  await writeFile(join(source, "answer.txt"), "before\n");
  await writeFile(join(source, "unrelated.txt"), "committed\n");
  await trustedGit(source, ["add", "."]); await trustedGit(source, ["commit", "-m", "fixture baseline"]);
  const baseCommit = (await trustedGit(source, ["rev-parse", "HEAD"])).toString().trim();
  const selected = [{ path: "unrelated.txt", bytes: Buffer.from("uncommitted user work\n") }, { path: "notes.txt", bytes: Buffer.from("untracked user work\n") }];
  for (const file of selected) await writeFile(join(source, file.path), file.bytes, { mode: 0o600 });
  const sourceBefore = await workspaceManifest(source);
  const workspace = await new PrivateCloneProvisioner(join(root, "clones")).provision({ executionId: randomUUID(), source, baseCommit, branch: "eval/scoped",
    inputs: selected.map((file) => ({ ...file, action: "write", sha256: contentHash(file.bytes), executable: false })) });
  const before = await workspaceManifest(workspace.hostPath);
  const broker = await brokerFixture(root, { cwd: workspace.hostPath });
  try {
    const instruction = await broker.instruct("make scoped change");
    await eventually(async () => (await broker.queue.list(broker.worker.id)).some((record) => record.id === instruction.id && record.status === "completed"), "SCOPED_INSTRUCTION_NOT_COMPLETED");
    const reports = (await readFile(join(broker.cwd, "reports.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const after = await workspaceManifest(broker.cwd), sourceAfter = await workspaceManifest(source);
    const beforeByPath = new Map(before.map((fact) => [fact.path, fact]));
    const actual = after.filter((fact) => !["commands.jsonl", "reports.jsonl"].includes(fact.path)
      && JSON.stringify(beforeByPath.get(fact.path)) !== JSON.stringify(fact)).map((fact) => fact.path);
    for (const fact of before) if (!after.some((next) => next.path === fact.path)) actual.push(fact.path);
    const preserved = (path: string) => JSON.stringify(beforeByPath.get(path)) === JSON.stringify(after.find((fact) => fact.path === path));
    return { brokerId: broker.brokerId, facts: { before, after, sourceBefore, sourceAfter, reports, instructions: await broker.queue.list(broker.worker.id) },
      expectedChangedPaths: ["answer.txt"], actualChangedPaths: actual, reportedChangedPaths: reports.at(-1).changedPaths as string[],
      unrelatedPathsChanged: ["unrelated.txt", "notes.txt"].filter((path) => !preserved(path)),
      checks: { "unrelated-tracked-preserved": preserved("unrelated.txt"), "unrelated-untracked-preserved": preserved("notes.txt"),
        "expected-change": actual.length === 1 && actual[0] === "answer.txt",
        "reported-changes-truthful": JSON.stringify(reports.at(-1).changedPaths) === JSON.stringify(actual),
        "dirty-source-preserved": JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter) },
    };
  } finally { await broker.close(); }
}
