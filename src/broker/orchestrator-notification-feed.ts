import type { InstructionRecord } from "../domain/instruction.js";
import { OrchestratorAttentionScheduling } from "./orchestrator-attention-scheduling.js";
import type { OrchestratorAttentionControlPlane } from "../orchestration/orchestrator-attention-control.js";
import type { OrchestratorBindingDirectory } from "../orchestration/orchestrator-controller-directory.js";
import { OrchestratorControllerDirectory } from "../orchestration/orchestrator-controller-directory.js";
import type { NoticeFilePort } from "../orchestration/orchestrator-notice-file-port.js";
import {
  OrchestratorNotificationControlPlane,
  type OrchestratorNotificationControlOptions,
} from "../orchestration/orchestrator-notification-control.js";
import type { NotificationInboxPort } from "../orchestration/orchestrator-notification-ports.js";
import type { InstructionRepository } from "../orchestration/session/session-ports.js";
import {
  OrchestratorNotificationDelivery,
  type OrchestratorNotificationDeliveryOptions,
} from "./orchestrator-notification-delivery.js";
import {
  OrchestratorNotificationProducer,
  type OrchestratorNotificationProducerOptions,
} from "./orchestrator-notification-producer.js";

export interface OrchestratorNotificationFeedOptions {
  /** Loaded before this is called; the feed never loads it. */
  inbox: NotificationInboxPort;
  noticeFiles: NoticeFilePort;
  bindings: OrchestratorBindingDirectory;
  registry: OrchestratorNotificationProducerOptions["registry"]
    & OrchestratorNotificationDeliveryOptions["registry"]
    & OrchestratorNotificationControlOptions["registry"];
  coordination: OrchestratorNotificationProducerOptions["coordination"];
  /** The queue's durable repository, read once at start for outstanding completion targets. */
  instructionRepository: Pick<InstructionRepository, "list">;
  now?: () => string;
  attention?: OrchestratorAttentionControlPlane;
}

export interface OrchestratorNotificationFeed {
  producer: OrchestratorNotificationProducer;
  control: OrchestratorNotificationControlPlane;
  readonly scheduling: OrchestratorAttentionScheduling | undefined;
  /** Hand the queue's repository through this so the producer sees every persisted instruction. */
  observeInstruction(record: InstructionRecord): void;
  /** Builds delivery once the instruction queue exists, then starts producer and delivery in order. */
  start(instructions: OrchestratorNotificationDeliveryOptions["instructions"]): Promise<OrchestratorNotificationDelivery>;
  stop(): void;
}

/**
 * The feed as one unit, assembled from ports so that `main.ts` only has to construct the two
 * infrastructure pieces (the inbox store and the notice-file adapter) and hand them here.
 *
 * Order matters and is fixed here: the producer must observe before the instruction queue starts
 * writing, delivery needs the queue to wake anyone, and the control plane needs delivery to answer
 * a notice. The producer is created first so the queue's repository wrapper can reference it.
 */
export function composeOrchestratorNotificationFeed(
  options: OrchestratorNotificationFeedOptions,
): OrchestratorNotificationFeed {
  const controllers = new OrchestratorControllerDirectory(options.bindings);
  const producer = new OrchestratorNotificationProducer({
    registry: options.registry,
    coordination: options.coordination,
    controllers,
    inbox: options.inbox,
    instructions: options.instructionRepository,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let delivery: OrchestratorNotificationDelivery | undefined;
  let scheduling: OrchestratorAttentionScheduling | undefined;
  const control = new OrchestratorNotificationControlPlane({
    inbox: options.inbox,
    bindings: options.bindings,
    registry: options.registry,
    delivery: { notice: (controllerId) => delivery?.notice(controllerId) ?? Promise.resolve(undefined) },
    ...(options.attention === undefined ? {} : { attention: options.attention }),
  });
  return {
    producer,
    control,
    get scheduling() { return scheduling; },
    observeInstruction(record) { producer.observeInstruction(record); scheduling?.observeInstruction(record); },
    async start(instructions) {
      if (options.attention !== undefined) scheduling = new OrchestratorAttentionScheduling({
        attention: options.attention, inbox: options.inbox, registry: options.registry, instructions,
        ...(options.now === undefined ? {} : { now: () => Date.parse(options.now!()) }),
      });
      delivery = new OrchestratorNotificationDelivery({
        inbox: options.inbox,
        controllers,
        registry: options.registry,
        instructions,
        noticeFiles: options.noticeFiles,
        ...(scheduling === undefined ? {} : { attention: scheduling }),
      });
      await producer.start();
      await options.attention?.start();
      await scheduling?.start();
      await delivery.start();
      return delivery;
    },
    stop() {
      delivery?.stop();
      scheduling?.stop();
      producer.stop();
      options.attention?.stop();
    },
  };
}
