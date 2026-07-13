import { randomUUID } from "node:crypto";

import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
  SheetCell,
  SheetSnapshot,
} from "../../adapter/Adapter.js";
import { ConflictError, SchemaDriftError } from "../errors/index.js";
import type { ColumnMap } from "../repository/DirectSheetRepository.js";
import {
  createRepositoryQueueTasks,
  type RepositoryQueuedWriteOperation,
} from "./QueuedWriteTaskProducer.js";
import {
  assertUniqueKeys,
  parseRepositoryRows,
  type ParsedRepositoryRow,
} from "../repository/RepositoryRowHelpers.js";
import { assertSchema } from "../schema/index.js";

interface RepositoryUpdateRequest<T extends Record<string, unknown>> {
  id: string;
  updater(current: T): T;
}

export type RepositoryWriteTransactionOperation<
  T extends Record<string, unknown>,
> =
  | {
      kind: "insert";
      row: T;
    }
  | {
      kind: "update";
      id: string;
      updater(current: T): T;
      expectedVersion?: number;
    }
  | {
      kind: "delete";
      id: string;
      expectedVersion?: number;
    };

export type RepositoryWriteTransactionResult<
  T extends Record<string, unknown>,
> = void | T | null;

export interface RepositoryQueueWriteTransactionOptions {
  transactionId: string;
}

export interface RepositoryQueueWriteExecutor<
  T extends Record<string, unknown>,
> {
  /** Creates an identity that remains stable across one transaction's retries. */
  createTransactionId(): string;
  /** Reports whether an ambiguous enqueue batch is retained for this identity. */
  hasMaterializedTransaction(transactionId: string): boolean;
  /** Discards a locally cached batch that the caller explicitly abandoned. */
  discardTransaction(transactionId: string): void;
  /** Re-enqueues a retained batch without consulting the current sheet state. */
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

interface RepositoryQueueWriteContext<T extends Record<string, unknown>> {
  adapter: AppsScriptQueueAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
  createTransactionId?(): string;
  createTaskId?(input: {
    transactionId: string;
    transactionIndex: number;
  }): string;
}

interface RepositorySnapshot<T extends Record<string, unknown>> {
  headers: Array<string>;
  parsedRows: Array<ParsedRepositoryRow<T>>;
}

interface MaterializedQueueWriteTransaction<
  T extends Record<string, unknown>,
> {
  results: Array<RepositoryWriteTransactionResult<T>>;
  tasks: EnqueueTasksInput;
  fingerprint: string;
  intentSnapshot: RepositorySnapshot<T>;
}

interface MaterializedRepositoryTransaction<
  T extends Record<string, unknown>,
> {
  results: Array<RepositoryWriteTransactionResult<T>>;
  tasks: EnqueueTasksInput | null;
  intentSnapshot: RepositorySnapshot<T>;
}

/**
 * Creates the queued repository write executor. It validates each requested
 * write against the current repository snapshot, converts it into queue task
 * payloads, and appends those tasks without directly mutating table rows.
 */
export function createRepositoryQueueWriteExecutor<
  T extends Record<string, unknown>,
>(
  input: RepositoryQueueWriteContext<T>,
): RepositoryQueueWriteExecutor<T> {
  let writeTail: Promise<void> = Promise.resolve();
  const materializedTransactions = new Map<
    string,
    MaterializedQueueWriteTransaction<T>
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
      materializedTransactions.has(transactionId),
    discardTransaction: (transactionId) => {
      materializedTransactions.delete(transactionId);
    },
    retryTransaction: (transactionId) =>
      runSerializedWrite(() =>
        retryMaterializedRepositoryTransaction(
          input,
          transactionId,
          materializedTransactions,
        ),
      ),
    insertRows: (rows) =>
      runSerializedWrite(() => insertRepositoryRows(input, rows)),
    updateRowsById: (requests) =>
      runSerializedWrite(() => updateRepositoryRowsById(input, requests)),
    deleteRowsById: (ids) =>
      runSerializedWrite(() => deleteRepositoryRowsById(input, ids)),
    writeTransaction: (operations, options) =>
      runSerializedWrite(() =>
        writeRepositoryTransaction(
          input,
          operations,
          options?.transactionId,
          materializedTransactions,
        ),
      ),
  };
}

async function retryMaterializedRepositoryTransaction<
  T extends Record<string, unknown>,
>(
  input: RepositoryQueueWriteContext<T>,
  transactionId: string,
  materializedTransactions: Map<
    string,
    MaterializedQueueWriteTransaction<T>
  >,
): Promise<Array<RepositoryWriteTransactionResult<T>>> {
  const cached = materializedTransactions.get(transactionId);

  if (cached === undefined) {
    throw new ConflictError(
      `Transaction "${transactionId}" has no retained materialized batch`,
    );
  }

  await input.adapter.enqueueTasks(cached.tasks);
  materializedTransactions.delete(transactionId);

  return cached.results;
}

async function insertRepositoryRows<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  rows: Array<T>,
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
  );

  return createVoidResults(rows.length);
}

async function updateRepositoryRowsById<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  requests: Array<RepositoryUpdateRequest<T>>,
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
  );

  return results.map((result) => (result === undefined ? null : result));
}

async function deleteRepositoryRowsById<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  ids: Array<string>,
): Promise<Array<T | null>> {
  const { key } = input;

  if (ids.length === 0) {
    return [];
  }

  const results = await writeRepositoryTransaction(
    input,
    ids.map((id) => ({
      kind: "delete" as const,
      id,
    })),
  );

  return results.map((result) => (result === undefined ? null : result));
}

/**
 * Retains the first materialized batch until enqueue succeeds. A retry is
 * materialized against the original immutable intent snapshot so a processor
 * can apply the task before the client receives and retries the response.
 */
async function writeRepositoryTransaction<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryWriteTransactionOperation<T>>,
  transactionId: string | undefined = undefined,
  materializedTransactions: Map<
    string,
    MaterializedQueueWriteTransaction<T>
  > = new Map(),
): Promise<Array<RepositoryWriteTransactionResult<T>>> {
  const cached =
    transactionId === undefined
      ? undefined
      : materializedTransactions.get(transactionId);

  if (operations.length === 0) {
    if (cached !== undefined) {
      throw new ConflictError(
        `Transaction "${transactionId}" has a different materialized task batch`,
      );
    }

    return [];
  }

  const materialized = await materializeRepositoryTransaction(
    input,
    operations,
    transactionId,
    cached?.intentSnapshot,
  );

  if (cached !== undefined) {
    if (
      materialized.tasks === null
      || createTaskBatchFingerprint(materialized.tasks) !== cached.fingerprint
    ) {
      throw new ConflictError(
        `Transaction "${transactionId}" has a different materialized task batch`,
      );
    }

    if (transactionId === undefined) {
      throw new Error("Cached queue transaction is missing its identity");
    }

    await input.adapter.enqueueTasks(cached.tasks);
    materializedTransactions.delete(transactionId);
    return cached.results;
  }

  if (materialized.tasks === null) {
    return materialized.results;
  }

  if (transactionId !== undefined) {
    materializedTransactions.set(transactionId, {
      results: materialized.results,
      tasks: materialized.tasks,
      fingerprint: createTaskBatchFingerprint(materialized.tasks),
      intentSnapshot: materialized.intentSnapshot,
    });
  }

  await input.adapter.enqueueTasks(materialized.tasks);

  if (transactionId !== undefined) {
    materializedTransactions.delete(transactionId);
  }

  return materialized.results;
}

async function materializeRepositoryTransaction<
  T extends Record<string, unknown>,
>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryWriteTransactionOperation<T>>,
  transactionId: string | undefined,
  intentSnapshot: RepositorySnapshot<T> | undefined = undefined,
): Promise<MaterializedRepositoryTransaction<T>> {
  const { key } = input;
  const isRetryMaterialization = intentSnapshot !== undefined;
  const snapshot =
    intentSnapshot === undefined
      ? await readRepositorySnapshot(input)
      : intentSnapshot;
  const rowsById = new Map(
    snapshot.parsedRows.map((parsedRow) => [
      String(parsedRow.row[key]),
      cloneRow(parsedRow.row),
    ]),
  );
  const queueOperations: Array<
    RepositoryQueuedWriteOperation<Record<string, SheetCell>>
  > = [];
  const results: Array<RepositoryWriteTransactionResult<T>> = [];

  for (const operation of operations) {
    if (operation.kind === "insert") {
      const id = String(operation.row[key]);

      if (rowsById.has(id)) {
        throw new SchemaDriftError(`Duplicate key "${id}"`);
      }

      rowsById.set(id, operation.row);
      queueOperations.push({
        kind: "insert",
        row: toQueueRowObject(input, operation.row),
      });
      results.push(undefined);
      continue;
    }

    const currentRow = rowsById.get(operation.id);

    if (currentRow === undefined) {
      if (operation.expectedVersion !== undefined) {
        throw new ConflictError(`Stale entity for key "${operation.id}"`);
      }

      results.push(null);
      continue;
    }

    const expectedVersion = Number(currentRow["_version"]);

    if (
      !isRetryMaterialization
      && operation.expectedVersion !== undefined
      && expectedVersion !== operation.expectedVersion
    ) {
      throw new ConflictError(`Stale entity for key "${operation.id}"`);
    }

    if (operation.kind === "update") {
      const rowToWrite = {
        ...operation.updater(currentRow),
        _version: expectedVersion + 1,
      } as T;

      rowsById.set(operation.id, rowToWrite);
      queueOperations.push({
        kind: "update",
        id: operation.id,
        expectedVersion,
        rowToWrite: toQueueRowObject(input, rowToWrite),
      });
      results.push(rowToWrite);
      continue;
    }

    rowsById.delete(operation.id);
    queueOperations.push({
      kind: "delete",
      id: operation.id,
      expectedVersion,
      rowToDelete: toQueueRowObject(input, currentRow),
    });
    results.push(currentRow);
  }

  return {
    results,
    tasks:
      queueOperations.length > 0
        ? createQueueTasks(input, queueOperations, transactionId)
        : null,
    intentSnapshot: snapshot,
  };
}

function createTaskBatchFingerprint(tasks: EnqueueTasksInput): string {
  return JSON.stringify(
    tasks.tasks.map((task) => [
      task.taskId,
      task.transactionId,
      task.transactionIndex,
      task.operation,
      task.sheetName,
      task.keyHeader,
      task.keyValue,
      task.expectedVersion,
      task.payloadJson,
    ]),
  );
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

function createQueueTasks<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryQueuedWriteOperation<Record<string, SheetCell>>>,
  transactionId = createTransactionId(input),
): EnqueueTasksInput {
  return createRepositoryQueueTasks<Record<string, SheetCell>>({
    sheetName: input.sheetName,
    key: input.key,
    transaction: {
      id: transactionId,
      operations,
    },
    createTaskId: ({ transactionIndex }) =>
      createTaskId(input, transactionId, transactionIndex),
  });
}

async function readRepositorySnapshot<T extends Record<string, unknown>>(
  input: {
    adapter: Pick<AppsScriptQueueAdapter, "readCanonicalSheet">;
    sheetName: string;
    key: keyof T & string;
    columns: ColumnMap<T>;
  },
): Promise<RepositorySnapshot<T>> {
  const { adapter, sheetName, key, columns } = input;
  const snapshot = await adapter.readCanonicalSheet(sheetName);

  assertSchema({
    headers: snapshot.headers,
    key,
    columns,
  });

  const parsedRows = parseRepositoryRows<T>({
    headers: snapshot.headers,
    sheetRows: snapshot.rows,
    columns,
  });

  assertUniqueKeys(
    parsedRows.map((parsedRow) => parsedRow.row),
    key,
  );

  return {
    headers: snapshot.headers,
    parsedRows,
  };
}

function toQueueRowObject<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  row: T,
): Record<string, SheetCell> {
  return Object.fromEntries(
    Object.entries(input.columns).map(([columnName, column]) => [
      columnName,
      column.serialize(row[columnName as keyof T]),
    ]),
  );
}

function cloneRow<T extends Record<string, unknown>>(row: T): T {
  return { ...row };
}

function createTransactionId<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
): string {
  if (input.createTransactionId !== undefined) {
    return input.createTransactionId();
  }

  return `tx-${randomUUID()}`;
}

function createTaskId<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  transactionId: string,
  transactionIndex: number,
): string {
  if (input.createTaskId !== undefined) {
    return input.createTaskId({
      transactionId,
      transactionIndex,
    });
  }

  return [transactionId, transactionIndex].join("-");
}

function createVoidResults(count: number): Array<void> {
  return Array.from({ length: count }, () => undefined);
}
