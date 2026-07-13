import { randomUUID } from "node:crypto";

import type { EnqueueTasksInput } from "../../adapter/queued/QueuedSheetAdapter.js";
import { ConflictError } from "../errors/index.js";
import {
  type RepositoryQueueWriteExecutor,
  type RepositoryQueueBatch,
  type RepositoryWriteTransactionOperation,
  type RepositoryWriteTransactionResult,
} from "./QueuedSheetWriteExecutor.js";

interface RepositoryUpdateRequest<T extends Record<string, unknown>> {
  id: string;
  updater(current: T): T;
}

export interface QueuedRepositoryTransactionCoordinatorOptions {
  /** Supplies deterministic transaction identities for tests or callers that need one. */
  createTransactionId?(): string;
}

export interface RepositoryQueueWriteTransactionOptions {
  /** Stable identity to reuse when an enqueue response is ambiguous. */
  transactionId: string;
}

export interface RepositoryQueueWriteCoordinator<
  T extends Record<string, unknown>,
> {
  /** Creates an identity for one queue batch and its retry attempts. */
  createTransactionId(): string;
  /** Reports whether an ambiguous batch is retained for this identity. */
  hasMaterializedTransaction(transactionId: string): boolean;
  /** Discards a retained batch that the caller explicitly abandoned. */
  discardTransaction(transactionId: string): void;
  /** Re-enqueues a retained batch without consulting current canonical state. */
  retryTransaction(
    transactionId: string,
  ): Promise<Array<RepositoryWriteTransactionResult<T>>>;
  insertRows(rows: Array<T>): Promise<Array<void>>;
  updateRowsById(
    requests: Array<RepositoryUpdateRequest<T>>,
  ): Promise<Array<T | null>>;
  deleteRowsById(ids: Array<string>): Promise<Array<T | null>>;
  writeTransaction(
    operations: Array<RepositoryWriteTransactionOperation<T>>,
    options?: RepositoryQueueWriteTransactionOptions,
  ): Promise<Array<RepositoryWriteTransactionResult<T>>>;
}

interface CreateQueuedRepositoryTransactionCoordinatorInput<
  T extends Record<string, unknown>,
> {
  executor: RepositoryQueueWriteExecutor<T>;
  createTransactionId?(): string;
}

interface RetainedQueueWriteBatch<T extends Record<string, unknown>>
  extends Omit<RepositoryQueueBatch<T>, "tasks" | "fingerprint"> {
  tasks: EnqueueTasksInput;
  fingerprint: string;
}

/**
 * Coordinates repository transaction scope with the low-level queue executor.
 * It owns serialization, retained batches, and ambiguous enqueue recovery; the
 * executor only validates operations and materializes or appends queue tasks.
 */
export function createQueuedRepositoryTransactionCoordinator<
  T extends Record<string, unknown>,
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
    hasMaterializedTransaction: (transactionId) =>
      retainedBatches.has(transactionId),
    discardTransaction: (transactionId) => {
      retainedBatches.delete(transactionId);
    },
    retryTransaction: (transactionId) =>
      runSerializedWrite(() =>
        retryRetainedQueueBatch(input.executor, transactionId, retainedBatches),
      ),
    insertRows: (rows) =>
      runSerializedWrite(() => insertRepositoryRows(input, rows, retainedBatches)),
    updateRowsById: (requests) =>
      runSerializedWrite(() =>
        updateRepositoryRowsById(input, requests, retainedBatches),
      ),
    deleteRowsById: (ids) =>
      runSerializedWrite(() =>
        deleteRepositoryRowsById(input, ids, retainedBatches),
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

async function retryRetainedQueueBatch<T extends Record<string, unknown>>(
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

async function insertRepositoryRows<T extends Record<string, unknown>>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
  rows: Array<T>,
  retainedBatches: Map<string, RetainedQueueWriteBatch<T>>,
): Promise<Array<void>> {
  if (rows.length === 0) {
    return [];
  }

  await writeRepositoryTransaction(
    input,
    rows.map((row) => ({
      kind: "insert",
      row,
    })),
    undefined,
    retainedBatches,
  );

  return createVoidResults(rows.length);
}

async function updateRepositoryRowsById<T extends Record<string, unknown>>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
  requests: Array<RepositoryUpdateRequest<T>>,
  retainedBatches: Map<string, RetainedQueueWriteBatch<T>>,
): Promise<Array<T | null>> {
  if (requests.length === 0) {
    return [];
  }

  assertUniqueRequestIds(requests);

  const results = await writeRepositoryTransaction(
    input,
    requests.map((request) => ({
      kind: "update" as const,
      id: request.id,
      updater: request.updater,
    })),
    undefined,
    retainedBatches,
  );

  return results.map((result) => (result === undefined ? null : result));
}

async function deleteRepositoryRowsById<T extends Record<string, unknown>>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
  ids: Array<string>,
  retainedBatches: Map<string, RetainedQueueWriteBatch<T>>,
): Promise<Array<T | null>> {
  if (ids.length === 0) {
    return [];
  }

  const results = await writeRepositoryTransaction(
    input,
    ids.map((id) => ({
      kind: "delete" as const,
      id,
    })),
    undefined,
    retainedBatches,
  );

  return results.map((result) => (result === undefined ? null : result));
}

/**
 * Retains an explicitly identified batch until enqueue succeeds. A retry with
 * the same transaction id re-materializes against the original intent only to
 * verify that a reconstructed callback describes the same immutable tasks.
 */
async function writeRepositoryTransaction<T extends Record<string, unknown>>(
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

function assertUniqueRequestIds<T extends Record<string, unknown>>(
  requests: Array<RepositoryUpdateRequest<T>>,
): void {
  const claimedIds = new Set<string>();

  for (const request of requests) {
    if (claimedIds.has(request.id)) {
      throw new ConflictError(`Duplicate update for key "${request.id}"`);
    }

    claimedIds.add(request.id);
  }
}

function createTransactionId<T extends Record<string, unknown>>(
  input: CreateQueuedRepositoryTransactionCoordinatorInput<T>,
): string {
  if (input.createTransactionId !== undefined) {
    return input.createTransactionId();
  }

  return `tx-${randomUUID()}`;
}

function createVoidResults(count: number): Array<void> {
  return Array.from({ length: count }, () => undefined);
}
