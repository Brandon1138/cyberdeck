# Resource-managed bounded jobs

The four native job adapters accept an optional `resourceLaunch: ResourceJobLaunchPort`.
Composition must supply the same managed launch port to each adapter before lifting the existing
managed-job refusal in `enforceJobExecutionPolicy`. The helper does not change execution policy:
jobs still accept only `host`/`host-compatible`, keep their explicitly selected provider/model,
and use the existing subscription environment. Codex remains one native first-party
`codex app-server --stdio --strict-config` process per job. There is no container, model, API-credit
or provider fallback.

## Composition

Construct `ResourceJobLaunch({ gate: resourceRuntime.gate, resolveRecord })`. A normal resolver is
`request => resourceJobRecord(jobs.dispatchContext(request.jobId), request)`, with any canonical
parent handling performed by the composition's existing authority resolver. `resourceJobRecord`
checks the current stored job ID, correlation, complete immutable request and queued lifecycle.
The launch helper resolves again inside the gate callback after the capacity wait, before any
preparation. Changed authority or a cancelled/interrupted/settled job blocks that launch.

`dispatchContext(jobId)` returns a detached canonical record, the stored delegated parent session
when present, and attempt generation 1. A job ID already denotes one immutable bounded dispatch
attempt: submission/delegation idempotency returns the existing job, there is no resume/retry
operation, queue pumping selects only queued jobs, and startup marks all prior nonterminal work
interrupted. A new attempt requires a new job ID. The resource ledger also rejects a second
request for the same workload/generation, including after its earlier reservation was released.
The job ID is the scheduling workload ID; this helper does not create a session, controller,
worktree lease or alternative authority derivation.

Root composition must select a family through an actual existing canonical binding using the
stored session provenance, or deliberately choose the `operator-job` scheduling bucket. Do not
parse a controller from the job ID or infer authority from an unrelated current controller.

## Launch and cancellation ordering

The shared gate fsyncs the resource request, waits for admission, and fsyncs `launching` before
calling adapter preparation. Codex's existing worktree lease acquisition and command/environment
construction occur inside this callback, preserving `holderJobId` and existing fencing/renewal.
The other adapters also build their commands and environments inside admission. No provider
preparation helper or child is launched while waiting for capacity.

The default native process handles now expose their actual child PID. The gate's existing
libproc sampler captures its precise birth identity and fsyncs the runtime binding before the
adapter acknowledges dispatch. Codex initialization and Claude stdin are withheld until then.
Cursor and Antigravity use prompts in their documented argv, so execution can begin at the
admitted spawn; their durable `launching` record covers the spawn-to-capture crash window.
Changing them to an undocumented delayed-stdin protocol would not provide valid provider proof.

The helper buffers exit and error events during capture for late gate/adapter subscribers. A
missing PID, failed capture or failed durable binding rejects dispatch and signals that exact
child handle; the reservation remains held when termination is unknown. Root PID or process-group
exit alone cannot prove every reparented native descendant has terminated. Therefore successful
job settlement is not resource release, and native reservations may remain visible cleanup debt
until an authoritative lifetime mechanism can prove termination. Restart preserves that debt.

While `dispatch()` waits, the canonical job lifecycle is still queued. The control plane tracks
that in-flight dispatch so cancellation reaches the adapter and `cancelStart(jobId)` instead of
only settling the job locally. The cancellation result wins over the consequent dispatch
rejection; a refused cancellation does not hide a real dispatch failure. Truly unstarted queued
jobs still settle directly. Canonical state is rechecked after admission even if cancellation
arrived through another route.

## Evidence limits

Mocked process and durable local-store tests cover admission-before-preparation, all four adapter
paths, exact job lease ownership, canonical context recovery, cancellation races, early exit,
missing identity, same-attempt restart fencing and retained native lifetime uncertainty. Tests
do not start installed provider CLIs or establish live subscription execution, real native
descendant attribution, termination proof, broker activation or production resource containment.
Those remain separate serialized live proof gates. This helper alone does not enable jobs in
composition; managed mode must continue refusing adapters without the injected launch port.
