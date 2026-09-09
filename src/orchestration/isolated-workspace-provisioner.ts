/** Provisioning port; Git and filesystem adapters stay in the runtime layer. */
export interface IsolatedWorkspaceRequest {
  executionId: string;
  source: string;
  baseCommit: string;
  branch: string;
  /** Exact broker-selected input files. No implicit untracked/ignored-file copying. */
  inputs: Array<{ path: string; action: "write"; sha256: string; executable: boolean; bytes: Uint8Array } | { path: string; action: "delete" }>;
}
export interface IsolatedWorkspace {
  mode: "independent-clone";
  executionId: string;
  hostPath: string;
  guestPath: "/workspace";
  source: string;
  baseCommit: string;
  branch: string;
  manifestHash: string;
}
export interface IsolatedWorkspaceProvisioner {
  provision(input: IsolatedWorkspaceRequest): Promise<IsolatedWorkspace>;
}
