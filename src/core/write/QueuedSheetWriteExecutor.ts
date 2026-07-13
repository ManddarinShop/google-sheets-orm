import type {
  AppsScriptQueueAdapter,
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
    }
  | {
      kind: "delete";
      id: string;
    };

export type RepositoryWriteTransactionResult<
  T extends Record<string, unknown>,
> = void | T | null;

export interface RepositoryQueueWriteExecutor<
  T extends Record<string, unknown>,
> {
  insertRows(rows: Array<T>): Promise<Array<void>>;
  updateRowsById(
    requests: Array<RepositoryUpdateRequest<T>>,
  ): Promise<Array<T | null>>;
  deleteRowsById(ids: Array<string>): Promise<Array<T | null>>;
  writeTransaction(
    operations: Array<RepositoryWriteTransactionOperation<T>>,
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

let defaultQueueWriteIdCounter = 0;

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
    insertRows: (rows) =>
      runSerializedWrite(() => insertRepositoryRows(input, rows)),
    updateRowsById: (requests) =>
      runSerializedWrite(() => updateRepositoryRowsById(input, requests)),
    deleteRowsById: (ids) =>
      runSerializedWrite(() => deleteRepositoryRowsById(input, ids)),
    writeTransaction: (operations) =>
      runSerializedWrite(() => writeRepositoryTransaction(input, operations)),
  };
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

async function writeRepositoryTransaction<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryWriteTransactionOperation<T>>,
): Promise<Array<RepositoryWriteTransactionResult<T>>> {
  if (operations.length === 0) {
    return [];
  }

  const { key } = input;
  const snapshot = await readRepositorySnapshot(input);
  const rowsById = new Map(
    snapshot.parsedRows.map((parsedRow) => [
      String(parsedRow.row[key]),
      parsedRow.row,
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
      results.push(null);
      continue;
    }

    const expectedVersion = Number(currentRow["_version"]);

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

  if (queueOperations.length > 0) {
    await enqueueOperations(input, queueOperations);
  }

  return results;
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

async function enqueueOperations<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryQueuedWriteOperation<Record<string, SheetCell>>>,
): Promise<void> {
  const transactionId = createTransactionId(input);

  await input.adapter.enqueueTasks(
    createRepositoryQueueTasks<Record<string, SheetCell>>({
      sheetName: input.sheetName,
      key: input.key,
      transaction: {
        id: transactionId,
        operations,
      },
      createTaskId: ({ transactionIndex }) =>
        createTaskId(input, transactionId, transactionIndex),
    }),
  );
}

async function readRepositorySnapshot<T extends Record<string, unknown>>(
  input: {
    adapter: { readSheet(sheetName: string): Promise<SheetSnapshot> };
    sheetName: string;
    key: keyof T & string;
    columns: ColumnMap<T>;
  },
): Promise<RepositorySnapshot<T>> {
  const { adapter, sheetName, key, columns } = input;
  const snapshot = await adapter.readSheet(sheetName);

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

function createTransactionId<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
): string {
  if (input.createTransactionId !== undefined) {
    return input.createTransactionId();
  }

  defaultQueueWriteIdCounter += 1;

  return [
    "tx",
    Date.now().toString(36),
    defaultQueueWriteIdCounter.toString(36),
  ].join("-");
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
