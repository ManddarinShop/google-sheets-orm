import { randomUUID } from "node:crypto";

import type { EnqueueTasksInput } from "../../../adapter/queued/QueuedSheetAdapter.js";
import { ConflictError } from "../../errors/index.js";
import {
  type RepositoryQueueWriteExecutor,
  type RepositoryQueueBatch,
  type RepositoryWriteTransactionOperation,
  type RepositoryWriteTransactionResult,
} from "../writer/QueuedSheetWriteExecutor.js";

const DEFAULT_RETAINED_BATCH_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETAINED_BATCHES = 100;

export interface QueuedRepositoryTransactionCoordinatorOptions {
  /** Supplies deterministic transaction identities for tests or callers that need one. */
  createTransactionId?(): string;
  /** Removes an ambiguous batch after this amount of time has elapsed. */
  retainedBatchTtlMs?: number;
  /** Bounds memory retained for batches that have not been acknowledged. */
  maxRetainedBatches?: number;
  /** Supplies the current time for retention cleanup and deterministic tests. */
  now?(): number;
}

export interface RepositoryQueueWriteTransactionOptions {
  /** Stable identity to reuse when an enqueue response is ambiguous. */
  transactionId: string;
}

export interface RepositoryQueueWriteCoordinator<
  T extends object,
> {
  /** Creates an identity for one queue batch and its retry attempts. */
  createTransactionId(): string;
  /** Discards a retained batch that the caller explicitly abandoned. */
  discardTransaction(transactionId: string): void;
  /** Re-enqueues a retained batch without consulting current canonical state. */
  retryTransaction(
    transactionId: string,
  ): Promise<Array<RepositoryWriteTransactionResult<T>>>;
  writeTransaction(
    operations: Array<RepositoryWriteTransactionOperation<T>>,
    options?: RepositoryQueueWriteTransactionOptions,
  ): Promise<Array<RepositoryWriteTransactionResult<T>>>;
}

interface CreateQueuedRepositoryTransactionCoordinatorInput<
  T extends object,
> extends QueuedRepositoryTransactionCoordinatorOptions {
  executor: RepositoryQueueWriteExecutor<T>;
}

interface RetainedQueueWriteBatch<T extends object>
  extends Omit<RepositoryQueueBatch<T>, "tasks" | "fingerprint"> {
  tasks: EnqueueTasksInput;
  fingerprint: string;
  retainedAtMs: number;
}

/**
 * Coordinates transaction scopes with the low-level queue executor. It owns
 * serialization and ambiguous enqueue recovery; the executor only validates,
 * materializes, and appends queue tasks.
 */
export function createQueuedRepositoryTransactionCoordinator<
  T extends object,
>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
): RepositoryQueueWriteCoordinator<T> {
  const retention = resolveRetentionPolicy(input);
  let writeTail: Promise<void> = Promise.resolve();
  const retainedBatches = new Map<
    string,
    RetainedQueueWriteBatch<T>
  >();

  function runSerializedWrite<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const result = writeTail.then(operation, operation);

    writeTail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  return {
    createTransactionId: () => createTransactionId(input),
    discardTransaction: (transactionId) => {
      pruneRetainedBatches(retainedBatches, retention);
      retainedBatches.delete(transactionId);
    },
    retryTransaction: (transactionId) =>
      runSerializedWrite(() => {
        pruneRetainedBatches(retainedBatches, retention);
        return retryRetainedQueueBatch(
          input.executor,
          transactionId,
          retainedBatches,
        );
      }),
    writeTransaction: (operations, options) =>
      runSerializedWrite(() => {
        pruneRetainedBatches(retainedBatches, retention);
        return writeRepositoryTransaction(
          input,
          operations,
          options?.transactionId,
          retainedBatches,
          retention,
        );
      }),
  };
}

interface RetentionPolicy {
  retainedBatchTtlMs: number;
  maxRetainedBatches: number;
  now(): number;
}

function resolveRetentionPolicy(
  input: QueuedRepositoryTransactionCoordinatorOptions,
): RetentionPolicy {
  const retainedBatchTtlMs = input.retainedBatchTtlMs
    ?? DEFAULT_RETAINED_BATCH_TTL_MS;
  const maxRetainedBatches = input.maxRetainedBatches
    ?? DEFAULT_MAX_RETAINED_BATCHES;

  if (!Number.isFinite(retainedBatchTtlMs) || retainedBatchTtlMs <= 0) {
    throw new RangeError("retainedBatchTtlMs must be greater than zero");
  }

  if (
    !Number.isInteger(maxRetainedBatches)
    || maxRetainedBatches <= 0
  ) {
    throw new RangeError("maxRetainedBatches must be a positive integer");
  }

  return {
    retainedBatchTtlMs,
    maxRetainedBatches,
    now: input.now ?? Date.now,
  };
}

function pruneRetainedBatches<T extends object>(
  retainedBatches: Map<string, RetainedQueueWriteBatch<T>>,
  retention: RetentionPolicy,
): void {
  const nowMs = retention.now();

  for (const [transactionId, batch] of retainedBatches) {
    if (nowMs - batch.retainedAtMs >= retention.retainedBatchTtlMs) {
      retainedBatches.delete(transactionId);
    }
  }

  while (retainedBatches.size > retention.maxRetainedBatches) {
    const oldest = retainedBatches.keys().next();

    if (oldest.done) {
      break;
    }

    retainedBatches.delete(oldest.value);
  }
}

async function retryRetainedQueueBatch<T extends object>(
  executor: RepositoryQueueWriteExecutor<T>,
  transactionId: string,
  retainedBatches: Map<string, RetainedQueueWriteBatch<T>>,
): Promise<Array<RepositoryWriteTransactionResult<T>>> {
  const cached = retainedBatches.get(transactionId);

  if (cached === undefined) {
    throw new ConflictError(
      `Transaction "${transactionId}" has no retained materialized batch`,
    );
  }

  await executor.enqueueTasks(cached.tasks);
  retainedBatches.delete(transactionId);

  return cached.results;
}

/**
 * Retains an explicitly identified batch until enqueue succeeds. A retry with
 * the same transaction id re-materializes against the original intent only to
 * verify that a reconstructed callback describes the same immutable tasks.
 */
async function writeRepositoryTransaction<T extends object>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
  operations: Array<RepositoryWriteTransactionOperation<T>>,
  transactionId: string | undefined,
  retainedBatches: Map<string, RetainedQueueWriteBatch<T>>,
  retention: RetentionPolicy,
): Promise<Array<RepositoryWriteTransactionResult<T>>> {
  const cached =
    transactionId === undefined
      ? undefined
      : retainedBatches.get(transactionId);

  if (operations.length === 0) {
    if (cached !== undefined) {
      throw new ConflictError(
        `Transaction "${transactionId}" has a different materialized task batch`,
      );
    }

    return [];
  }

  const effectiveTransactionId =
    transactionId ?? createTransactionId(input);
  const materialized = await input.executor.materializeQueueBatch(
    operations,
    cached === undefined
      ? { transactionId: effectiveTransactionId }
      : {
          transactionId: effectiveTransactionId,
          intentSnapshot: cached.intentSnapshot,
        },
  );

  if (cached !== undefined) {
    if (
      materialized.tasks === null
      || materialized.fingerprint !== cached.fingerprint
    ) {
      throw new ConflictError(
        `Transaction "${transactionId}" has a different materialized task batch`,
      );
    }

    await input.executor.enqueueTasks(cached.tasks);
    retainedBatches.delete(effectiveTransactionId);
    return cached.results;
  }

  if (materialized.tasks === null) {
    return materialized.results;
  }

  if (transactionId !== undefined) {
    if (materialized.fingerprint === null) {
      throw new Error("Materialized queue tasks are missing a fingerprint");
    }

    retainedBatches.set(transactionId, {
      results: materialized.results,
      tasks: materialized.tasks,
      fingerprint: materialized.fingerprint,
      intentSnapshot: materialized.intentSnapshot,
      retainedAtMs: retention.now(),
    });

    pruneRetainedBatches(retainedBatches, retention);
  }

  await input.executor.enqueueTasks(materialized.tasks);

  if (transactionId !== undefined) {
    retainedBatches.delete(transactionId);
  }

  return materialized.results;
}

function createTransactionId<T extends object>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
): string {
  if (input.createTransactionId !== undefined) {
    return input.createTransactionId();
  }

  return `tx-${randomUUID()}`;
}
