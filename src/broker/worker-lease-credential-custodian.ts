export interface WorkerLeaseCredential {
  leaseToken: string;
  leaseVersion: number;
}

export interface WorkerLeaseCredentialCustodian {
  get(controllerId: string, workerId: string): WorkerLeaseCredential | undefined;
  set(controllerId: string, workerId: string, credential: WorkerLeaseCredential): void;
  delete(controllerId: string, workerId: string): void;
}

/**
 * Process-local broker custody for fenced worker lease tokens.
 *
 * Both controller actions and worker reporting use this one store. Restart intentionally loses
 * every token, forcing explicit ownership recovery instead of reconstructing authority from
 * durable controller identity alone.
 */
export class BrokerWorkerLeaseCredentialCustodian implements WorkerLeaseCredentialCustodian {
  private readonly credentials = new Map<string, WorkerLeaseCredential>();

  get(controllerId: string, workerId: string): WorkerLeaseCredential | undefined {
    return this.credentials.get(key(controllerId, workerId));
  }

  set(controllerId: string, workerId: string, credential: WorkerLeaseCredential): void {
    this.credentials.set(key(controllerId, workerId), credential);
  }

  delete(controllerId: string, workerId: string): void {
    this.credentials.delete(key(controllerId, workerId));
  }
}

function key(controllerId: string, workerId: string): string {
  return `${controllerId}\0${workerId}`;
}
