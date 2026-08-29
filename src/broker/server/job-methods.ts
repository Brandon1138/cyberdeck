import {
  AcknowledgeReportParamsSchema,
  CancelJobParamsSchema,
  GetJobParamsSchema,
  IngestReportParamsSchema,
  SubmitJobParamsSchema,
} from "../../control-plane/job-control-plane.js";
import { DelegationIntentSchema } from "../../domain/delegation.js";
import {
  type BrokerMethodHandler,
  requireControlPlane,
  withJobWorkerMode,
} from "./method-context.js";

/** The control plane's neutral job and queue surface, plus the broker's own two answers. */
export const jobMethods: Record<string, BrokerMethodHandler> = {
  "job.submit": async (server, _context, frame) => {
    const request = SubmitJobParamsSchema.parse(frame.params);
    return requireControlPlane(server.options).submit({
      ...request,
      request: await withJobWorkerMode(server.options, request.request),
    });
  },
  "job.delegate": async (server, _context, frame) => {
    const intent = DelegationIntentSchema.parse(frame.params);
    const request = intent.parentJobId === undefined
      ? await withJobWorkerMode(server.options, intent.request)
      : intent.request;
    return requireControlPlane(server.options).delegate({
      ...intent,
      request,
    });
  },
  "job.get": async (server, _context, frame) => {
    const { jobId } = GetJobParamsSchema.parse(frame.params);
    return requireControlPlane(server.options).getJob(jobId);
  },
  "job.list": async (server, _context, _frame) => {
    return requireControlPlane(server.options).listJobs();
  },
  "job.cancel": async (server, _context, frame) => {
    const { jobId, reason } = CancelJobParamsSchema.parse(frame.params);
    return requireControlPlane(server.options).cancel(jobId, reason);
  },
  "job.report": async (server, _context, frame) => {
    const { report } = IngestReportParamsSchema.parse(frame.params);
    return requireControlPlane(server.options).ingestReport(report);
  },
  "job.acknowledgeReport": async (server, _context, frame) => {
    const { jobId } = AcknowledgeReportParamsSchema.parse(frame.params);
    return requireControlPlane(server.options).acknowledgeReport(jobId);
  },
  // Neutral, non-presentational control-plane queries. They return structured state only;
  // rendering, copy, and dashboards belong to the client/presentation layer.
  "control.queue": async (server, _context, _frame) => {
    return requireControlPlane(server.options).queueSnapshot();
  },
  "control.budget": async (server, _context, _frame) => {
    return requireControlPlane(server.options).budgetReport();
  },
  "control.reconciliation": async (server, _context, _frame) => {
    return (
      server.options.controlPlaneRuntime?.lastReconciliation() ?? {
        reconciledAt: null,
        findings: [],
        quarantinedJobIds: [],
      }
    );
  },
  "job.reportBacks": async (server, _context, _frame) => {
    return requireControlPlane(server.options).listReportBacks();
  },
  "broker.status": async (server, _context, _frame) => {
    return { healthy: true, pid: process.pid, workers: server.options.registry.workerCapacity() };
  },
  "broker.shutdown": async (_server, _context, _frame) => {
    return { shuttingDown: true };
  },
};
