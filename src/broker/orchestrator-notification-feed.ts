import type { InstructionRecord } from "../domain/instruction.js";
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
}

export interface OrchestratorNotificationFeed {
  producer: OrchestratorNotificationProducer;
  control: OrchestratorNotificationControlPlane;
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
  const control = new OrchestratorNotificationControlPlane({
    inbox: options.inbox,
    bindings: options.bindings,
    registry: options.registry,
    delivery: { notice: (controllerId) => delivery?.notice(controllerId) ?? Promise.resolve(undefined) },
  });
  return {
    producer,
    control,
    observeInstruction: (record) => producer.observeInstruction(record),
    async start(instructions) {
      delivery = new OrchestratorNotificationDelivery({
        inbox: options.inbox,
        controllers,
        registry: options.registry,
        instructions,
        noticeFiles: options.noticeFiles,
      });
      await producer.start();
      await delivery.start();
      return delivery;
    },
    stop() {
      delivery?.stop();
      producer.stop();
    },
  };
}
