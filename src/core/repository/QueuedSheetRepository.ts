import type {
  AppsScriptQueueAdapter,
  ProcessTaskQueueInput,
  ProcessTaskQueueResult,
} from "../../adapter/Adapter.js";
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

export interface QueuedSheetRepository<T extends Record<string, unknown>> {
  ensureSheet(): Promise<void>;
  findAll(): Promise<Array<T>>;
  findById(id: string): Promise<T | null>;
  insert(row: T): Promise<void>;
  update(id: string, updater: (current: T) => T): Promise<T | null>;
  deleteById(id: string): Promise<T | null>;
  createTransaction(): QueuedRepositoryTransaction<T>;
  transaction<TResult>(
    callback: (transaction: QueuedRepositoryTransaction<T>) => TResult | Promise<TResult>,
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
}

/**
 * Creates a queued repository facade with MikroORM-style transaction helpers.
 * Writes are collected in a transaction scope and flushed as one queue
 * transaction, while reads still use the adapter's current read sheet.
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
    const snapshot = await adapter.readSheet(sheetName);

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

  async function insert(row: T): Promise<void> {
    const transaction = createTransaction();

    transaction.insert(row);
    await transaction.flush();
  }

  async function update(
    id: string,
    updater: (current: T) => T,
  ): Promise<T | null> {
    const transaction = createTransaction();
    transaction.update(id, updater);

    const [updatedRow] = await transaction.flush();

    return updatedRow ?? null;
  }

  async function deleteById(id: string): Promise<T | null> {
    const transaction = createTransaction();
    const current = await transaction.findById(id);

    if (current === null) {
      return null;
    }

    transaction.remove(current);

    const [deletedRow] = await transaction.flush();

    return deletedRow ?? null;
  }

  function createTransaction(): QueuedRepositoryTransaction<T> {
    return createQueuedRepositoryTransaction({
      findAll,
      key,
      processTaskQueue: (processInput) => adapter.processTaskQueue(processInput),
      writeExecutor,
    });
  }

  async function transaction<TResult>(
    callback: (transaction: QueuedRepositoryTransaction<T>) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const transactionScope = createTransaction();

    try {
      const result = await callback(transactionScope);

      await transactionScope.flush();

      return result;
    } catch (error) {
      transactionScope.clear();
      throw error;
    }
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
}): QueuedRepositoryTransaction<T> {
  const pendingOperations: Array<RepositoryWriteTransactionOperation<T>> = [];

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
    });
  }

  function remove(row: T): void {
    const rowSnapshot = cloneRow(row);

    pushPendingOperation({
      kind: "delete",
      id: String(rowSnapshot[input.key]),
    });
  }

  async function flush(): Promise<Array<void | T | null>> {
    if (pendingOperations.length === 0) {
      return [];
    }

    const operations = [...pendingOperations];
    const result = await input.writeExecutor.writeTransaction(operations);

    pendingOperations.splice(0, operations.length);

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
    };
  }

  function clear(): void {
    pendingOperations.splice(0, pendingOperations.length);
  }

  function pushPendingOperation(
    operation: RepositoryWriteTransactionOperation<T>,
  ): void {
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
    flushAndProcessQueue,
    clear,
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
    return {
      kind: "update",
      id: String(operation.row[key]),
      updater: () => cloneRow(operation.row),
    };
  }

  if (existingOperation.kind === "delete") {
    return operation;
  }

  return {
    kind: "update",
    id: operation.id,
    updater: (current) => operation.updater(existingOperation.updater(current)),
  };
}
