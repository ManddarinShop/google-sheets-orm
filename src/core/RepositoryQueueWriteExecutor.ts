import type {
  AppsScriptQueueAdapter,
  SheetCell,
  SheetSnapshot,
} from "../adapter/Adapter.js";
import { ConflictError } from "./Errors.js";
import type { ColumnMap } from "./Repository.js";
import {
  createRepositoryQueueTasks,
  type RepositoryQueuedWriteOperation,
} from "./RepositoryQueueTaskProducer.js";
import {
  assertUniqueKeys,
  findParsedRowByIdOrNull,
  parseRepositoryRows,
  type ParsedRepositoryRow,
} from "./RepositoryRows.js";
import type {
  RepositoryUpdateRequest,
  RepositoryWriteExecutor,
} from "./RepositoryWriteExecutor.js";
import { assertSchema } from "./Schema.js";

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
): RepositoryWriteExecutor<T> {
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
  };
}

async function insertRepositoryRows<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  rows: Array<T>,
): Promise<Array<void>> {
  const { key } = input;

  if (rows.length === 0) {
    return [];
  }

  const snapshot = await readRepositorySnapshot(input);
  const existingRows = snapshot.parsedRows.map((parsedRow) => parsedRow.row);

  assertUniqueKeys([...existingRows, ...rows], key);

  await enqueueOperations(
    input,
    rows.map((row) => ({
      kind: "insert",
      row: toQueueRowObject(input, row),
    })),
  );

  return createVoidResults(rows.length);
}

async function updateRepositoryRowsById<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  requests: Array<RepositoryUpdateRequest<T>>,
): Promise<Array<T | null>> {
  const { key } = input;

  if (requests.length === 0) {
    return [];
  }

  const snapshot = await readRepositorySnapshot(input);
  const claimedIds = new Set<string>();
  const resolvedUpdates = requests.map((request) => {
    if (claimedIds.has(request.id)) {
      throw new ConflictError(`Duplicate update for key "${request.id}"`);
    }

    const target = findParsedRowByIdOrNull({
      parsedRows: snapshot.parsedRows,
      key,
      id: request.id,
    });

    if (target === null) {
      return null;
    }

    claimedIds.add(request.id);

    const currentVersion = Number(target.row["_version"]);
    const rowToWrite = {
      ...request.updater(target.row),
      _version: currentVersion + 1,
    } as T;

    return {
      id: request.id,
      expectedVersion: currentVersion,
      rowToWrite,
    };
  });
  const operations = resolvedUpdates
    .filter((update): update is NonNullable<typeof update> => update !== null)
    .map((update) => ({
      kind: "update" as const,
      id: update.id,
      expectedVersion: update.expectedVersion,
      rowToWrite: toQueueRowObject(input, update.rowToWrite),
    }));

  if (operations.length > 0) {
    await enqueueOperations(input, operations);
  }

  return resolvedUpdates.map((update) => update?.rowToWrite ?? null);
}

async function deleteRepositoryRowsById<T extends Record<string, unknown>>(
  input: RepositoryQueueWriteContext<T>,
  ids: Array<string>,
): Promise<Array<T | null>> {
  const { key } = input;

  if (ids.length === 0) {
    return [];
  }

  const snapshot = await readRepositorySnapshot(input);
  const claimedIds = new Set<string>();
  const targets = ids.map((id) => {
    if (claimedIds.has(id)) {
      return null;
    }

    const target = findParsedRowByIdOrNull({
      parsedRows: snapshot.parsedRows,
      key,
      id,
    });

    if (target !== null) {
      claimedIds.add(id);
    }

    return target;
  });
  const operations = targets
    .filter((target): target is ParsedRepositoryRow<T> => target !== null)
    .map((target) => {
      const id = String(target.row[key]);
      const expectedVersion = Number(target.row["_version"]);

      return {
        kind: "delete" as const,
        id,
        expectedVersion,
        rowToDelete: toQueueRowObject(input, target.row),
      };
    });

  if (operations.length > 0) {
    await enqueueOperations(input, operations);
  }

  return targets.map((target) => target?.row ?? null);
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
