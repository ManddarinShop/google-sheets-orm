import { randomUUID } from "node:crypto";

import type { EnqueueTasksInput } from "../../../adapter/queued/QueuedSheetAdapter.js";
import { ConflictError } from "../../errors/index.js";
import {
  type RepositoryQueueWriteExecutor,
  type RepositoryQueueBatch,
  type RepositoryWriteTransactionOperation,
  type RepositoryWriteTransactionResult,
} from "../writer/QueuedSheetWriteExecutor.js";

export interface QueuedRepositoryTransactionCoordinatorOptions {
  /** Supplies deterministic transaction identities for tests or callers that need one. */
  createTransactionId?(): string;
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
> {
  executor: RepositoryQueueWriteExecutor<T>;
  createTransactionId?(): string;
}

interface RetainedQueueWriteBatch<T extends object>
  extends Omit<RepositoryQueueBatch<T>, "tasks" | "fingerprint"> {
  tasks: EnqueueTasksInput;
  fingerprint: string;
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
      retainedBatches.delete(transactionId);
    },
    retryTransaction: (transactionId) =>
      runSerializedWrite(() =>
        retryRetainedQueueBatch(input.executor, transactionId, retainedBatches),
      ),
    writeTransaction: (operations, options) =>
      runSerializedWrite(() =>
        writeRepositoryTransaction(
          input,
          operations,
          options?.transactionId,
          retainedBatches,
        ),
      ),
  };
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
    });
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
