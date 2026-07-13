import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
} from "../../../adapter/queued/QueuedSheetAdapter.js";
import type {
  SheetCell,
  SheetSnapshot,
} from "../../../adapter/shared/SheetAdapter.js";
import { ConflictError, SchemaDriftError } from "../../errors/index.js";
import type { ColumnMap } from "../../shared/RepositoryTypes.js";
import {
  createRepositoryQueueTasks,
  type RepositoryQueuedWriteOperation,
} from "./QueuedWriteTaskProducer.js";
import {
  assertUniqueKeys,
  parseRepositoryRows,
  readRepositoryProperty,
  type ParsedRepositoryRow,
} from "../../shared/RepositoryRowHelpers.js";
import { assertSchema } from "../../schema/index.js";

export type RepositoryWriteTransactionOperation<
  T extends object,
> =
  | {
      kind: "insert";
      row: T;
    }
  | {
      kind: "save";
      row: T;
      requireExisting: boolean;
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
  T extends object,
> = void | T | null;

export interface RepositorySnapshot<T extends object> {
  headers: Array<string>;
  parsedRows: Array<ParsedRepositoryRow<T>>;
}

export interface RepositoryQueueBatchMaterializationOptions<
  T extends object,
> {
  transactionId: string;
  intentSnapshot?: RepositorySnapshot<T>;
}

export interface RepositoryQueueBatch<
  T extends object,
> {
  results: Array<RepositoryWriteTransactionResult<T>>;
  tasks: EnqueueTasksInput | null;
  fingerprint: string | null;
  intentSnapshot: RepositorySnapshot<T>;
}

interface MaterializedRepositoryWrite<T extends object> {
  results: Array<RepositoryWriteTransactionResult<T>>;
  tasks: EnqueueTasksInput | null;
  intentSnapshot: RepositorySnapshot<T>;
}

export interface RepositoryQueueWriteExecutor<
  T extends object,
> {
  /**
   * Validates repository operations and converts them into an immutable queue
   * batch without retaining transaction lifecycle state.
   */
  materializeQueueBatch(
    operations: Array<RepositoryWriteTransactionOperation<T>>,
    options: RepositoryQueueBatchMaterializationOptions<T>,
  ): Promise<RepositoryQueueBatch<T>>;
  /** Appends one already-materialized batch to the queue adapter. */
  enqueueTasks(tasks: EnqueueTasksInput): Promise<void>;
}

interface RepositoryQueueWriteContext<T extends object> {
  adapter: AppsScriptQueueAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
  createTaskId?(input: {
    transactionId: string;
    transactionIndex: number;
  }): string;
}

/**
 * Creates the low-level queued write executor. It validates operations against
 * canonical state and materializes immutable queue tasks; transaction scope,
 * retry retention, and write serialization belong to the repository
 * transaction coordinator.
 */
export function createRepositoryQueueWriteExecutor<
  T extends object,
>(
  input: RepositoryQueueWriteContext<T>,
): RepositoryQueueWriteExecutor<T> {
  return {
    materializeQueueBatch: (operations, options) =>
      materializeRepositoryTransaction(
        input,
        operations,
        options.transactionId,
        options.intentSnapshot,
      ).then((materialized) => ({
        ...materialized,
        fingerprint:
          materialized.tasks === null
            ? null
            : createTaskBatchFingerprint(materialized.tasks),
      })),
    enqueueTasks: async (tasks) => {
      await input.adapter.enqueueTasks(tasks);
    },
  };
}

async function materializeRepositoryTransaction<
  T extends object,
>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryWriteTransactionOperation<T>>,
  transactionId: string,
  intentSnapshot: RepositorySnapshot<T> | undefined = undefined,
): Promise<MaterializedRepositoryWrite<T>> {
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

    if (operation.kind === "save") {
      const id = String(operation.row[key]);
      const currentRow = rowsById.get(id);

      if (currentRow === undefined) {
        if (operation.requireExisting) {
          throw new ConflictError(`Stale entity for key "${id}"`);
        }

        rowsById.set(id, cloneRow(operation.row));
        queueOperations.push({
          kind: "insert",
          row: toQueueRowObject(input, operation.row),
        });
        results.push(undefined);
        continue;
      }

      if (!operation.requireExisting) {
        throw new SchemaDriftError(`Duplicate key "${id}"`);
      }

      const expectedVersion = Number(
        readRepositoryProperty(operation.row, "_version"),
      );

      if (
        !isRetryMaterialization
        && expectedVersion !== Number(
          readRepositoryProperty(currentRow, "_version"),
        )
      ) {
        throw new ConflictError(`Stale entity for key "${id}"`);
      }

      const rowToWrite = {
        ...operation.row,
        _version: Number(readRepositoryProperty(currentRow, "_version")) + 1,
      } as T;

      rowsById.set(id, rowToWrite);
      queueOperations.push({
        kind: "update",
        id,
        expectedVersion: Number(
          readRepositoryProperty(currentRow, "_version"),
        ),
        rowToWrite: toQueueRowObject(input, rowToWrite),
      });
      results.push(rowToWrite);
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

    const expectedVersion = Number(
      readRepositoryProperty(currentRow, "_version"),
    );

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

function createQueueTasks<T extends object>(
  input: RepositoryQueueWriteContext<T>,
  operations: Array<RepositoryQueuedWriteOperation<Record<string, SheetCell>>>,
  transactionId: string,
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

async function readRepositorySnapshot<T extends object>(
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

function toQueueRowObject<T extends object>(
  input: RepositoryQueueWriteContext<T>,
  row: T,
): Record<string, SheetCell> {
  return Object.fromEntries(
    Object.keys(input.columns).map((columnName) => {
      const column = input.columns[columnName as keyof T];

      return [
        columnName,
        column.serialize(row[columnName as keyof T]),
      ];
    }),
  );
}

function cloneRow<T extends object>(row: T): T {
  return { ...row };
}

function createTaskId<T extends object>(
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
