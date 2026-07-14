import type {
  EnqueueTaskInput,
  EnqueueTasksInput,
} from "../../../adapter/queued/QueuedSheetAdapter.js";
import { readRepositoryProperty } from "../../shared/RepositoryRowHelpers.js";

export type RepositoryQueuedWriteOperation<T extends object> =
  | {
      kind: "insert";
      row: T;
    }
  | {
      kind: "update";
      id: string;
      expectedVersion: number;
      rowToWrite: T;
    }
  | {
      kind: "delete";
      id: string;
      expectedVersion: number;
      rowToDelete: T;
    };

export interface RepositoryQueuedWriteTransaction<
  T extends object,
> {
  id: string;
  operations: Array<RepositoryQueuedWriteOperation<T>>;
}

export interface CreateRepositoryQueueTasksInput<
  T extends object,
> {
  sheetName: string;
  key: keyof T & string;
  transaction: RepositoryQueuedWriteTransaction<T>;
  createTaskId(input: {
    transactionId: string;
    transactionIndex: number;
    operation: RepositoryQueuedWriteOperation<T>;
  }): string;
}

/**
 * Converts an explicit repository write transaction into queue tasks. This
 * producer does not infer transaction boundaries from timing or batching; the
 * caller must pass the exact operations that belong to the transaction.
 */
export function createRepositoryQueueTasks<
  T extends object,
>(input: CreateRepositoryQueueTasksInput<T>): EnqueueTasksInput {
  const { sheetName, key, transaction, createTaskId } = input;

  return {
    tasks: transaction.operations.map((operation, transactionIndex) => {
      const base = {
        taskId: createTaskId({
          transactionId: transaction.id,
          transactionIndex,
          operation,
        }),
        transactionId: transaction.id,
        transactionIndex,
        sheetName,
        keyHeader: key,
        keyValue: readOperationKeyValue(operation, key),
      };

      return createQueueTask(base, operation);
    }),
  };
}

function createQueueTask<T extends object>(
  base: {
    taskId: string;
    transactionId: string;
    transactionIndex: number;
    sheetName: string;
    keyHeader: string;
    keyValue: string;
  },
  operation: RepositoryQueuedWriteOperation<T>,
): EnqueueTaskInput {
  switch (operation.kind) {
    case "insert":
      assertFiniteVersion(operation.row, "Queued insert row");

      return {
        ...base,
        operation: "insert",
        expectedVersion: null,
        payloadJson: JSON.stringify({
          row: operation.row,
        }),
      };

    case "update":
      assertRowKeyMatchesId(
        operation.rowToWrite,
        operation.id,
        base.keyHeader,
        "Queued update rowToWrite",
      );
      assertAdvancedVersion(operation.expectedVersion, operation.rowToWrite);

      return {
        ...base,
        operation: "update",
        expectedVersion: operation.expectedVersion,
        payloadJson: JSON.stringify({
          expectedVersion: operation.expectedVersion,
          rowToWrite: operation.rowToWrite,
        }),
      };

    case "delete":
      assertRowKeyMatchesId(
        operation.rowToDelete,
        operation.id,
        base.keyHeader,
        "Queued delete rowToDelete",
      );
      assertExpectedVersion(
        operation.rowToDelete,
        operation.expectedVersion,
        "Queued delete rowToDelete",
      );

      return {
        ...base,
        operation: "delete",
        expectedVersion: operation.expectedVersion,
        payloadJson: JSON.stringify({
          expectedVersion: operation.expectedVersion,
          rowToDelete: operation.rowToDelete,
        }),
      };
  }
}

function readOperationKeyValue<T extends object>(
  operation: RepositoryQueuedWriteOperation<T>,
  key: string,
): string {
  if (operation.kind === "delete") {
    return operation.id;
  }

  if (operation.kind === "update") {
    return operation.id;
  }

  return String(readRepositoryProperty(operation.row, key));
}

function assertAdvancedVersion<T extends object>(
  expectedVersion: number,
  rowToWrite: T,
): void {
  if (!Number.isFinite(expectedVersion)) {
    throw new Error("Queued update expectedVersion must be finite");
  }

  const versionToWrite = readRepositoryProperty(rowToWrite, "_version");

  if (
    typeof versionToWrite !== "number" ||
    !Number.isFinite(versionToWrite) ||
    versionToWrite <= expectedVersion
  ) {
    throw new Error("Queued update row must advance _version");
  }
}

function assertFiniteVersion<T extends object>(
  row: T,
  label: string,
): void {
  const version = readRepositoryProperty(row, "_version");

  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new Error(`${label} must include a finite numeric _version`);
  }
}

function assertExpectedVersion<T extends object>(
  row: T,
  expectedVersion: number,
  label: string,
): void {
  assertFiniteVersion(row, label);

  if (readRepositoryProperty(row, "_version") !== expectedVersion) {
    throw new Error(`${label} _version must match expectedVersion`);
  }
}

function assertRowKeyMatchesId<T extends object>(
  row: T,
  id: string,
  key: string,
  label: string,
): void {
  if (String(readRepositoryProperty(row, key)) !== id) {
    throw new Error(`${label} key must match id`);
  }
}
