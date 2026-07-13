import type {
  AppsScriptQueueAdapter,
  ProcessTaskQueueInput,
  ProcessTaskQueueResult,
  SheetSnapshot,
} from "../../adapter/Adapter.js";
import { ConflictError } from "../errors/index.js";
import { Column } from "../schema/Columns.js";
import { parseRow, assertSchema } from "../schema/index.js";
import { assertUniqueKeys } from "./RepositoryRowHelpers.js";
import {
  createRepositoryQueueWriteExecutor,
  type RepositoryQueueWriteExecutor,
  type RepositoryWriteTransactionOperation,
} from "../write/index.js";

export type QueuedColumnMap<T extends Record<string, unknown>> = {
  [K in keyof T]: Column<T[K]>;
};

export interface CreateQueuedSheetRepositoryInput<
  T extends Record<string, unknown>,
> {
  adapter: AppsScriptQueueAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: QueuedColumnMap<T>;
}

export interface QueuedRepositoryTransactionOptions {
  /** Stable identity to reuse when the transaction is retried after an ambiguous enqueue result. */
  transactionId?: string;
}

export interface QueuedSheetRepository<T extends Record<string, unknown>> {
  ensureSheet(): Promise<void>;
  findAll(): Promise<Array<T>>;
  findById(id: string): Promise<T | null>;
  insert(row: T, options?: QueuedRepositoryTransactionOptions): Promise<void>;
  update(
    id: string,
    updater: (current: T) => T,
    options?: QueuedRepositoryTransactionOptions,
  ): Promise<T | null>;
  deleteById(
    id: string,
    options?: QueuedRepositoryTransactionOptions,
  ): Promise<T | null>;
  createTransaction(
    options?: QueuedRepositoryTransactionOptions,
  ): QueuedRepositoryTransaction<T>;
  transaction<TResult>(
    callback: (transaction: QueuedRepositoryTransaction<T>) => TResult | Promise<TResult>,
    options?: QueuedRepositoryTransactionOptions,
  ): Promise<TResult>;
}

export interface QueuedRepositoryTransaction<T extends Record<string, unknown>> {
  findAll(): Promise<Array<T>>;
  findById(id: string): Promise<T | null>;
  insert(row: T): void;
  update(id: string, updater: (current: T) => T): void;
  save(row: T): void;
  remove(row: T): void;
  flush(): Promise<Array<void | T | null>>;
  /** Re-enqueues an ambiguous batch without reading the current sheet. */
  retry(): Promise<Array<void | T | null>>;
  flushAndProcessQueue(
    input?: ProcessTaskQueueInput,
  ): Promise<QueuedRepositoryProcessedFlushResult<T>>;
  clear(): void;
}

export interface QueuedRepositoryProcessedFlushResult<
  T extends Record<string, unknown>,
> {
  writeResults: Array<void | T | null>;
  processResult: ProcessTaskQueueResult;
  processing: QueuedRepositoryQueueProcessingSummary;
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
 * Creates a queued repository facade with MikroORM-style transaction helpers.
 * Writes are collected in a transaction scope and flushed as one queue
 * transaction, while reads always use the adapter's gateway-owned canonical
 * state. Queued adapters must expose this path so processed writes and
 * optimistic-lock checks do not read the visible projection by accident.
 */
export function createQueuedSheetRepository<
  T extends Record<string, unknown>,
>(
  input: CreateQueuedSheetRepositoryInput<T>,
): QueuedSheetRepository<T> {
  const { adapter, sheetName, key, columns } = input;
  const writeExecutor = createRepositoryQueueWriteExecutor(input);

  async function ensureSheet(): Promise<void> {
    await adapter.initializeSystemSheets(sheetName, Object.keys(columns));
  }

  async function findAll(): Promise<Array<T>> {
    const snapshot = await readQueuedRepositorySheet(adapter, sheetName);

    assertSchema({
      headers: snapshot.headers,
      key,
      columns,
    });

    const rows = snapshot.rows.map((row) =>
      parseRow<T>({
        headers: snapshot.headers,
        cells: row.cells,
        columns,
      }),
    );

    assertUniqueKeys(rows, key);

    return rows;
  }

  async function findById(id: string): Promise<T | null> {
    const rows = await findAll();

    return rows.find((row) => String(row[key]) === id) ?? null;
  }

  async function insert(
    row: T,
    options: QueuedRepositoryTransactionOptions = {},
  ): Promise<void> {
    const transaction = createTransaction(options);

    transaction.insert(row);
    await transaction.flush();
  }

  async function update(
    id: string,
    updater: (current: T) => T,
    options: QueuedRepositoryTransactionOptions = {},
  ): Promise<T | null> {
    const transaction = createTransaction(options);
    transaction.update(id, updater);

    const [updatedRow] = await transaction.flush();

    return updatedRow ?? null;
  }

  async function deleteById(
    id: string,
    options: QueuedRepositoryTransactionOptions = {},
  ): Promise<T | null> {
    const transaction = createTransaction(options);
    const current = await transaction.findById(id);

    if (current === null) {
      if (
        options.transactionId !== undefined
        && writeExecutor.hasMaterializedTransaction(options.transactionId)
      ) {
        const [deletedRow] = await transaction.retry();

        return deletedRow ?? null;
      }

      return null;
    }

    transaction.remove(current);

    const [deletedRow] = await transaction.flush();

    return deletedRow ?? null;
  }

  function createTransaction(
    options: QueuedRepositoryTransactionOptions = {},
  ): QueuedRepositoryTransaction<T> {
    return createQueuedRepositoryTransaction({
      findAll,
      key,
      processTaskQueue: (processInput) => adapter.processTaskQueue(processInput),
      writeExecutor,
      ...(options.transactionId === undefined
        ? {}
        : { transactionId: options.transactionId }),
    });
  }

  async function transaction<TResult>(
    callback: (transaction: QueuedRepositoryTransaction<T>) => TResult | Promise<TResult>,
    options: QueuedRepositoryTransactionOptions = {},
  ): Promise<TResult> {
    const transactionScope = createTransaction(options);
    let result: TResult;

    try {
      result = await callback(transactionScope);
    } catch (error) {
      transactionScope.clear();
      throw error;
    }

    // Keep an ambiguous enqueue batch cached so callers can retry this method
    // with the same transactionId. Callback failures are cleared above, while
    // flush failures intentionally escape without clearing the batch.
    await transactionScope.flush();

    return result;
  }

  return {
    ensureSheet,
    findAll,
    findById,
    insert,
    update,
    deleteById,
    createTransaction,
    transaction,
  };
}

function createQueuedRepositoryTransaction<
  T extends Record<string, unknown>,
>(input: {
  findAll(): Promise<Array<T>>;
  key: keyof T & string;
  processTaskQueue(input?: ProcessTaskQueueInput): Promise<ProcessTaskQueueResult>;
  writeExecutor: RepositoryQueueWriteExecutor<T>;
  transactionId?: string;
}): QueuedRepositoryTransaction<T> {
  const pendingOperations: Array<RepositoryWriteTransactionOperation<T>> = [];
  let inFlightOperations: Array<RepositoryWriteTransactionOperation<T>> | null =
    null;
  let inFlightTransactionId: string | null = input.transactionId ?? null;

  function insert(row: T): void {
    pushPendingOperation({
      kind: "insert",
      row: cloneRow(row),
    });
  }

  function update(id: string, updater: (current: T) => T): void {
    pushPendingOperation({
      kind: "update",
      id,
      updater,
    });
  }

  function save(row: T): void {
    const rowSnapshot = cloneRow(row);

    pushPendingOperation({
      kind: "update",
      id: String(rowSnapshot[input.key]),
      updater: () => rowSnapshot,
      expectedVersion: Number(rowSnapshot["_version"]),
    });
  }

  function remove(row: T): void {
    const rowSnapshot = cloneRow(row);

    pushPendingOperation({
      kind: "delete",
      id: String(rowSnapshot[input.key]),
      expectedVersion: Number(rowSnapshot["_version"]),
    });
  }

  /**
   * Enqueues one immutable batch and keeps its identity/materialized payload
   * when the adapter result is ambiguous, so a caller retry cannot append a
   * second transaction.
   */
  async function flush(): Promise<Array<void | T | null>> {
    if (pendingOperations.length === 0) {
      return [];
    }

    const operations = inFlightOperations ?? [...pendingOperations];
    const transactionId =
      inFlightTransactionId ?? input.writeExecutor.createTransactionId();

    inFlightOperations = operations;
    inFlightTransactionId = transactionId;

    const result = await input.writeExecutor.writeTransaction(operations, {
      transactionId,
    });

    pendingOperations.splice(0, operations.length);
    inFlightOperations = null;
    inFlightTransactionId = null;

    return result;
  }

  async function flushAndProcessQueue(
    processInput?: ProcessTaskQueueInput,
  ): Promise<QueuedRepositoryProcessedFlushResult<T>> {
    const writeResults = await flush();
    const processResult = await input.processTaskQueue(processInput);

    return {
      writeResults,
      processResult,
      processing: summarizeProcessTaskQueueResult(processResult),
    };
  }

  async function retry(): Promise<Array<void | T | null>> {
    const transactionId = inFlightTransactionId ?? input.transactionId;

    if (transactionId === undefined || transactionId === null) {
      throw new ConflictError(
        "Transaction retry requires a stable transactionId",
      );
    }

    if (inFlightOperations === null && pendingOperations.length > 0) {
      throw new ConflictError(
        "Transaction has unflushed operations; flush them before retrying",
      );
    }

    const result = await input.writeExecutor.retryTransaction(transactionId);
    const operationsToClear = inFlightOperations?.length ?? 0;

    if (operationsToClear > 0) {
      pendingOperations.splice(0, operationsToClear);
    }

    inFlightOperations = null;
    inFlightTransactionId = null;

    return result;
  }

  function clear(): void {
    if (inFlightTransactionId !== null) {
      input.writeExecutor.discardTransaction(inFlightTransactionId);
    }

    pendingOperations.splice(0, pendingOperations.length);
    inFlightOperations = null;
    inFlightTransactionId = null;
  }

  function pushPendingOperation(
    operation: RepositoryWriteTransactionOperation<T>,
  ): void {
    if (inFlightOperations !== null) {
      throw new Error(
        "Cannot mutate a queued repository transaction while a flush retry is pending; retry flush or clear the transaction first",
      );
    }

    const existingIndex = pendingOperations.findIndex(
      (pendingOperation) =>
        getPendingOperationId(pendingOperation, input.key)
          === getPendingOperationId(operation, input.key),
    );

    if (existingIndex === -1) {
      pendingOperations.push(operation);
      return;
    }

    const existingOperation = pendingOperations[existingIndex];

    if (existingOperation === undefined) {
      throw new Error("Pending operation index disappeared");
    }

    const nextOperation = mergePendingOperations({
      existingOperation,
      operation,
      key: input.key,
    });

    if (nextOperation === null) {
      pendingOperations.splice(existingIndex, 1);
      return;
    }

    pendingOperations[existingIndex] = nextOperation;
  }

  async function findAll(): Promise<Array<T>> {
    const rows = await input.findAll();
    const rowsById = new Map(rows.map((row) => [String(row[input.key]), row]));

    for (const operation of pendingOperations) {
      if (operation.kind === "insert") {
        rowsById.set(String(operation.row[input.key]), cloneRow(operation.row));
        continue;
      }

      if (operation.kind === "update") {
        const currentRow = rowsById.get(operation.id);

        if (currentRow === undefined) {
          continue;
        }

        rowsById.set(operation.id, cloneRow(operation.updater(currentRow)));
        continue;
      }

      rowsById.delete(operation.id);
    }

    return [...rowsById.values()];
  }

  async function findById(id: string): Promise<T | null> {
    const rows = await findAll();

    return rows.find((row) => String(row[input.key]) === id) ?? null;
  }

  return {
    findAll,
    findById,
    insert,
    update,
    save,
    remove,
    flush,
    retry,
    flushAndProcessQueue,
    clear,
  };
}

function readQueuedRepositorySheet(
  adapter: AppsScriptQueueAdapter,
  sheetName: string,
): Promise<SheetSnapshot> {
  return adapter.readCanonicalSheet(sheetName);
}

/**
 * Converts raw queue processor counters into a small status object. The raw
 * counters remain available for diagnostics, while callers can branch on this
 * summary without reimplementing queue-state rules.
 */
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

function cloneRow<T extends Record<string, unknown>>(row: T): T {
  return { ...row };
}

function getPendingOperationId<T extends Record<string, unknown>>(
  operation: RepositoryWriteTransactionOperation<T>,
  key: keyof T & string,
): string {
  if (operation.kind === "insert") {
    return String(operation.row[key]);
  }

  return operation.id;
}

function mergePendingOperations<T extends Record<string, unknown>>(input: {
  existingOperation: RepositoryWriteTransactionOperation<T>;
  operation: RepositoryWriteTransactionOperation<T>;
  key: keyof T & string;
}): RepositoryWriteTransactionOperation<T> | null {
  const { existingOperation, operation, key } = input;

  if (operation.kind === "delete") {
    return existingOperation.kind === "insert" ? null : operation;
  }

  if (existingOperation.kind === "insert") {
    const currentRow = cloneRow(existingOperation.row);
    const row =
      operation.kind === "insert"
        ? cloneRow(operation.row)
        : {
            ...operation.updater(currentRow),
            [key]: currentRow[key],
          } as T;

    return {
      kind: "insert",
      row,
    };
  }

  if (operation.kind === "insert") {
    return withExpectedVersion(
      {
        kind: "update",
        id: String(operation.row[key]),
        updater: () => cloneRow(operation.row),
      },
      existingOperation.expectedVersion,
    );
  }

  if (existingOperation.kind === "delete") {
    return operation;
  }

  return withExpectedVersion(
    {
      kind: "update",
      id: operation.id,
      updater: (current) => operation.updater(existingOperation.updater(current)),
    },
    operation.expectedVersion ?? existingOperation.expectedVersion,
  );
}

function withExpectedVersion<T extends Record<string, unknown>>(
  operation: Extract<RepositoryWriteTransactionOperation<T>, { kind: "update" }>,
  expectedVersion: number | undefined,
): Extract<RepositoryWriteTransactionOperation<T>, { kind: "update" }> {
  return expectedVersion === undefined
    ? operation
    : { ...operation, expectedVersion };
}
