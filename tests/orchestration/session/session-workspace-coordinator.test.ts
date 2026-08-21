import { describe, expect, it, vi } from "vitest";
import type { StartSessionRequest } from "../../../src/domain/session.js";
import type {
  ProvisionedWorktree,
  WorkerWorkspace,
  WorktreeProvisioner,
} from "../../../src/domain/worker-workspace.js";
import {
  SessionWorkspaceCoordinator,
  SessionWorkspaceError,
} from "../../../src/orchestration/session/session-workspace-coordinator.js";
import type {
  WorkspaceProvisioningFacts,
} from "../../../src/orchestration/session/session-workspace-ports.js";

const cyberdeckProvisioned: WorkerWorkspace = {
  branch: "cyberdeck/mik-141",
  baseRef: "HEAD",
  provisioning: "cyberdeck-provisioned",
  writableRoots: [],
};

function request(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    ...overrides,
  };
}

function scoutRequest(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return request({
    provider: "cursor",
    model: "composer",
    sandbox: "read-only",
    approvalMode: "auto",
    kind: "worker",
    profile: "scout",
    brief: {
      objective: "Find the seam",
      scope: ["src"],
      questions: ["Where does provisioning happen?"],
      stopCondition: "One card",
      budget: { maxWallClockMs: 60_000, maxTokens: 1_000 },
    },
    ...overrides,
  });
}

/** A provisioner that records what it was asked to do and touches no disk. */
function fakeProvisioner(overrides: { failWith?: Error } = {}) {
  const provisioned: string[] = [];
  const discarded: WorkerWorkspace[] = [];
  const provisioner: WorktreeProvisioner = {
    provision: async ({ workspace, sessionId }) => {
      provisioned.push(sessionId);
      if (overrides.failWith !== undefined) throw overrides.failWith;
      return {
        workspace: {
          ...workspace,
          worktreePath: "/tmp/repo-mik-141",
          repositoryPath: "/tmp/repo",
        },
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        warnings: ["/tmp/repo-mik-141 has no node_modules"],
      } satisfies ProvisionedWorktree;
    },
    discard: async (workspace) => { discarded.push(workspace); },
  };
  return { provisioner, provisioned, discarded };
}

function harness(options: {
  provisioner?: WorktreeProvisioner;
  validateCwd?: (cwd: string) => Promise<void>;
  workspaceState?: (cwd: string) => Promise<string>;
  failJournal?: Error;
} = {}) {
  const journaled: Array<{ sessionId: string; facts: WorkspaceProvisioningFacts }> = [];
  const coordinator = new SessionWorkspaceCoordinator({
    journal: {
      workspaceProvisioned: async (sessionId, facts) => {
        journaled.push({ sessionId, facts });
        if (options.failJournal !== undefined) throw options.failJournal;
      },
    },
    ...(options.validateCwd === undefined ? {} : { validateCwd: options.validateCwd }),
    ...(options.workspaceState === undefined ? {} : { workspaceState: options.workspaceState }),
    ...(options.provisioner === undefined ? {} : { provisioner: options.provisioner }),
  });
  return { coordinator, journaled };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionWorkspaceCoordinator start verification", () => {
  it("refuses a Scout with no brief, the wrong lifecycle, or the wrong provider shape", async () => {
    const { coordinator } = harness();

    await expect(coordinator.verifyStartRequest(scoutRequest({ brief: undefined })))
      .rejects.toMatchObject({
        code: "INVALID_WORKER_PROFILE",
        message: "Scout profile requires a structured brief",
      });
    await expect(coordinator.verifyStartRequest(scoutRequest({ kind: "orchestrator" })))
      .rejects.toMatchObject({
        code: "INVALID_WORKER_PROFILE",
        message: "Scout profile can only use worker lifecycle",
      });
    await expect(coordinator.verifyStartRequest(scoutRequest({ sandbox: "workspace-write" })))
      .rejects.toMatchObject({
        code: "INVALID_WORKER_PROFILE",
        message:
          "Scout profile requires Cursor Composer, read-only sandbox, auto approval, and normal worker mode",
      });
    await expect(coordinator.verifyStartRequest(scoutRequest({ workerMode: "caveman" })))
      .rejects.toMatchObject({ code: "INVALID_WORKER_PROFILE" });
  });

  it("refuses a Scout brief whose scope escapes the worker cwd", async () => {
    const { coordinator } = harness();

    await expect(coordinator.verifyStartRequest(scoutRequest({
      brief: { ...scoutRequest().brief!, scope: ["../elsewhere"] },
    }))).rejects.toMatchObject({
      code: "INVALID_WORKER_PROFILE",
      message: "Scout scope escapes worker cwd: ../elsewhere",
    });
  });

  it("checks the cwd for every profile, and only after the profile itself is coherent", async () => {
    const seen: string[] = [];
    const { coordinator } = harness({
      validateCwd: async (cwd) => { seen.push(cwd); },
    });

    await coordinator.verifyStartRequest(request());
    expect(seen).toEqual(["/tmp/repo"]);

    // A refused profile never reaches the filesystem: the request could not launch either way, and
    // the profile answer is the one the caller can act on.
    await expect(coordinator.verifyStartRequest(scoutRequest({ brief: undefined }))).rejects.toThrow();
    expect(seen).toEqual(["/tmp/repo"]);
  });

  it("reports an inaccessible cwd exactly as the check worded it", async () => {
    const { coordinator } = harness({
      validateCwd: async (cwd) => {
        throw new SessionWorkspaceError(
          "INVALID_SESSION_CWD",
          `Session cwd is not an accessible directory: ${cwd}`,
        );
      },
    });

    await expect(coordinator.verifyStartRequest(request({ cwd: "/tmp/gone" })))
      .rejects.toMatchObject({
        code: "INVALID_SESSION_CWD",
        message: "Session cwd is not an accessible directory: /tmp/gone",
      });
  });
});

describe("SessionWorkspaceCoordinator provisioning", () => {
  it("provisions nothing for a workspace it was not asked to create", async () => {
    const { provisioner, provisioned } = fakeProvisioner();
    const { coordinator, journaled } = harness({ provisioner });

    expect(await coordinator.provision(request(), "session-1")).toBeUndefined();
    expect(await coordinator.provision(request({
      workspace: {
        worktreePath: "/tmp/repo",
        branch: "brandon/mik-141",
        baseRef: "main",
        provisioning: "pre-provisioned",
        writableRoots: [],
      },
    }), "session-2")).toBeUndefined();
    expect(provisioned).toEqual([]);
    expect(journaled).toEqual([]);
  });

  it("refuses the start when no provisioner is configured rather than sharing the checkout", async () => {
    const { coordinator } = harness();

    await expect(coordinator.provision(request({ workspace: cyberdeckProvisioned }), "session-1"))
      .rejects.toMatchObject({
        code: "WORKSPACE_PROVISIONER_UNAVAILABLE",
        message:
          "This broker cannot provision worktrees; pre-provision one and declare provisioning "
          + "pre-provisioned",
      });
  });

  it("journals the facts the provisioner answered with", async () => {
    const { provisioner, provisioned } = fakeProvisioner();
    const { coordinator, journaled } = harness({ provisioner });

    const result = await coordinator.provision(
      request({ workspace: cyberdeckProvisioned }),
      "session-1",
    );

    expect(provisioned).toEqual(["session-1"]);
    expect(result?.workspace.worktreePath).toBe("/tmp/repo-mik-141");
    expect(journaled).toEqual([{
      sessionId: "session-1",
      facts: {
        worktreePath: "/tmp/repo-mik-141",
        repositoryPath: "/tmp/repo",
        branch: "cyberdeck/mik-141",
        baseRef: "HEAD",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        warnings: ["/tmp/repo-mik-141 has no node_modules"],
      },
    }]);
  });

  it("reports a provisioning failure as a start failure and gives nothing back", async () => {
    const { provisioner, discarded } = fakeProvisioner({ failWith: new Error("branch already exists") });
    const { coordinator } = harness({ provisioner });

    await expect(coordinator.provision(request({ workspace: cyberdeckProvisioned }), "session-1"))
      .rejects.toMatchObject({
        code: "WORKSPACE_PROVISION_FAILED",
        message: "branch already exists",
      });
    // Nothing was created, so there is nothing this start is entitled to delete.
    expect(discarded).toEqual([]);
  });

  it("gives the worktree back when the journal rejects, leaving the branch free to retry", async () => {
    const { provisioner, discarded } = fakeProvisioner();
    const { coordinator } = harness({ provisioner, failJournal: new Error("journal unavailable") });

    await expect(coordinator.provision(request({ workspace: cyberdeckProvisioned }), "session-1"))
      .rejects.toMatchObject({
        code: "WORKSPACE_PROVISION_FAILED",
        message:
          "Worktree /tmp/repo-mik-141 was created and then given back because its provisioning "
          + "could not be journaled: journal unavailable",
      });
    expect(discarded).toEqual([expect.objectContaining({ worktreePath: "/tmp/repo-mik-141" })]);
  });

  it("discards only a worktree this start created, and survives a refusing discard", async () => {
    const { provisioner, discarded } = fakeProvisioner();
    const { coordinator } = harness({ provisioner });

    await coordinator.discardFailedStart(undefined);
    expect(discarded).toEqual([]);

    const provisioned = await coordinator.provision(
      request({ workspace: cyberdeckProvisioned }),
      "session-1",
    );
    await coordinator.discardFailedStart(provisioned);
    expect(discarded).toEqual([expect.objectContaining({ worktreePath: "/tmp/repo-mik-141" })]);

    const refusing = harness({
      provisioner: {
        provision: provisioner.provision,
        discard: async () => { throw new Error("worktree has changes"); },
      },
    });
    await expect(refusing.coordinator.discardFailedStart(provisioned)).resolves.toBeUndefined();
  });
});

describe("SessionWorkspaceCoordinator workspace state", () => {
  it("shares one in-flight reading per directory and starts a fresh one after it settles", async () => {
    const pending = deferred<string>();
    const workspaceState = vi.fn(async (cwd: string) => {
      if (cwd === "/tmp/repo") return pending.promise;
      return "other";
    });
    const { coordinator } = harness({ workspaceState });

    const first = coordinator.captureWorkspaceState("/tmp/repo");
    const second = coordinator.captureWorkspaceState("/tmp/repo");
    // A different directory is a different reading, so it is never deduplicated into the first.
    const elsewhere = coordinator.captureWorkspaceState("/tmp/other");
    expect(workspaceState).toHaveBeenCalledTimes(2);

    pending.resolve("hash-1");
    expect(await first).toBe("hash-1");
    expect(await second).toBe("hash-1");
    expect(await elsewhere).toBe("other");

    // Settled is not cached: the next ask reads the tree again rather than answering from before.
    workspaceState.mockImplementation(async () => "hash-2");
    expect(await coordinator.captureWorkspaceState("/tmp/repo")).toBe("hash-2");
    expect(workspaceState).toHaveBeenCalledTimes(3);
  });

  it("drops a failed reading so the next caller is not handed the old rejection", async () => {
    let attempt = 0;
    const workspaceState = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("git exploded");
      return "hash-2";
    });
    const { coordinator } = harness({ workspaceState });

    await expect(coordinator.captureWorkspaceState("/tmp/repo")).rejects.toThrow("git exploded");
    expect(await coordinator.captureWorkspaceState("/tmp/repo")).toBe("hash-2");
  });

  it("refuses to invent a reading when nothing can read the workspace", async () => {
    const { coordinator } = harness();

    await expect(coordinator.captureWorkspaceState("/tmp/repo")).rejects.toThrow(
      "This broker cannot read workspace state; no state reader is configured",
    );
  });
});

describe("SessionWorkspaceCoordinator Scout verification", () => {
  it("fails a Scout with no pre-launch baseline rather than passing it unverified", async () => {
    const workspaceState = vi.fn(async () => "hash-1");
    const { coordinator } = harness({ workspaceState });

    expect(await coordinator.verifyScoutWorkspace(undefined, "/tmp/repo")).toEqual({
      ok: false,
      reason: "Scout has no pre-launch workspace state baseline",
    });
    // There is nothing to compare against, so nothing is read.
    expect(workspaceState).not.toHaveBeenCalled();
  });

  it("reports a failed post-run reading as a verification failure", async () => {
    const { coordinator } = harness({
      workspaceState: async () => { throw new Error("git exploded"); },
    });

    expect(await coordinator.verifyScoutWorkspace("hash-1", "/tmp/repo")).toEqual({
      ok: false,
      reason: "Post-run workspace verification failed: git exploded",
    });
  });

  it("fails a Scout whose observable repository state moved", async () => {
    const { coordinator } = harness({ workspaceState: async () => "hash-2" });

    expect(await coordinator.verifyScoutWorkspace("hash-1", "/tmp/repo")).toEqual({
      ok: false,
      reason: "Scout changed observable repository state despite its read-only profile",
    });
  });

  it("verifies a Scout that left the repository as it found it", async () => {
    const { coordinator } = harness({ workspaceState: async () => "hash-1" });

    expect(await coordinator.verifyScoutWorkspace("hash-1", "/tmp/repo")).toEqual({
      ok: true,
      workspaceStateHash: "hash-1",
    });
  });
});
