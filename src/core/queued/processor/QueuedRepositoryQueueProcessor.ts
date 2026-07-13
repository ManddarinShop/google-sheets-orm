import type {
  AppsScriptQueueAdapter,
  ProcessTaskQueueInput,
  ProcessTaskQueueResult,
} from "../../../adapter/queued/QueuedSheetAdapter.js";

export interface QueuedRepositoryQueueProcessor {
  /** Processes pending queue transaction groups independently of repositories. */
  processTaskQueue(
    input?: ProcessTaskQueueInput,
  ): Promise<ProcessTaskQueueResult>;
}

export type QueuedRepositoryQueueProcessingStatus =
  | "idle"
  | "processed"
  | "pending"
  | "failed";

export interface QueuedRepositoryQueueProcessingSummary {
  status: QueuedRepositoryQueueProcessingStatus;
  processedAny: boolean;
  hasFailures: boolean;
  hasPendingTasks: boolean;
}

/**
 * Creates the operational queue processor facade. Keeping this separate from
 * the repository makes queue draining an infrastructure action instead of a
 * repository write method.
 */
export function createQueuedRepositoryQueueProcessor(
  adapter: Pick<AppsScriptQueueAdapter, "processTaskQueue">,
): QueuedRepositoryQueueProcessor {
  return {
    processTaskQueue: (input) => adapter.processTaskQueue(input),
  };
}

/** Converts raw processor counters into a small branch-friendly status. */
export function summarizeProcessTaskQueueResult(
  result: ProcessTaskQueueResult,
): QueuedRepositoryQueueProcessingSummary {
  const hasFailures =
    result.failedTransactions > 0 || result.failedTasks > 0;
  const hasPendingTasks = result.remainingPendingTasks > 0;
  const processedAny =
    result.processedTransactions > 0 || result.processedTasks > 0;

  if (hasFailures) {
    return {
      status: "failed",
      processedAny,
      hasFailures,
      hasPendingTasks,
    };
  }

  if (hasPendingTasks) {
    return {
      status: "pending",
      processedAny,
      hasFailures,
      hasPendingTasks,
    };
  }

  if (processedAny) {
    return {
      status: "processed",
      processedAny,
      hasFailures,
      hasPendingTasks,
    };
  }

  return {
    status: "idle",
    processedAny,
    hasFailures,
    hasPendingTasks,
  };
}
