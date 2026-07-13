import { ConflictError } from "../../errors/index.js";
import type { QueuedRepositoryTransaction } from "../public/QueuedRepositoryApi.js";
import type { RepositoryQueueWriteCoordinator } from "./QueuedRepositoryTransactionCoordinator.js";
import type {
  RepositoryWriteTransactionOperation,
} from "../writer/QueuedSheetWriteExecutor.js";

export interface InternalQueuedRepositoryTransactionScope<
  T extends Record<string, unknown>,
> extends QueuedRepositoryTransaction<T> {
  flush(): Promise<Array<void | T | null>>;
  /** Re-enqueues an ambiguous batch without reading the current sheet. */
  retry(): Promise<Array<void | T | null>>;
  clear(): void;
}

export interface CreateQueuedRepositoryTransactionScopeInput<
  T extends Record<string, unknown>,
> {
  findAll(): Promise<Array<T>>;
  key: keyof T & string;
  writeCoordinator: RepositoryQueueWriteCoordinator<T>;
  transactionId?: string;
}

/**
 * Creates the internal unit of work used by the public repository facade.
 * Pending operations, queue flushing, and retry recovery stay here so the
 * public transaction callback only exposes entity reads and mutations.
 */
export function createQueuedRepositoryTransactionScope<
  T extends Record<string, unknown>,
>(
  input: CreateQueuedRepositoryTransactionScopeInput<T>,
): InternalQueuedRepositoryTransactionScope<T> {
  const pendingOperations: Array<RepositoryWriteTransactionOperation<T>> = [];
  const knownEntityIds = new Set<string>();
  let inFlightOperations: Array<RepositoryWriteTransactionOperation<T>> | null =
    null;
  let inFlightTransactionId: string | null = input.transactionId ?? null;

  function save(row: T): void {
    const rowSnapshot = cloneRow(row);

    pushPendingOperation({
      kind: "save",
      row: rowSnapshot,
      requireExisting: knownEntityIds.has(String(rowSnapshot[input.key])),
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
      inFlightTransactionId ?? input.writeCoordinator.createTransactionId();

    inFlightOperations = operations;
    inFlightTransactionId = transactionId;

    const result = await input.writeCoordinator.writeTransaction(operations, {
      transactionId,
    });

    pendingOperations.splice(0, operations.length);
    inFlightOperations = null;
    inFlightTransactionId = null;

    return result;
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

    const result = await input.writeCoordinator.retryTransaction(transactionId);
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
      input.writeCoordinator.discardTransaction(inFlightTransactionId);
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
    for (const row of rows) {
      knownEntityIds.add(String(row[input.key]));
    }

    const rowsById = new Map(rows.map((row) => [String(row[input.key]), row]));

    for (const operation of pendingOperations) {
      if (operation.kind === "insert" || operation.kind === "save") {
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
    save,
    remove,
    flush,
    retry,
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
  if (operation.kind === "insert" || operation.kind === "save") {
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

  if (operation.kind === "save") {
    if (existingOperation.kind === "insert") {
      return {
        kind: "insert",
        row: cloneRow(operation.row),
      };
    }

    return operation;
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
    if (existingOperation.kind === "save") {
      return {
        kind: "save",
        row: cloneRow(operation.row),
        requireExisting: existingOperation.requireExisting,
      };
    }

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

  if (existingOperation.kind === "save") {
    return {
      kind: "update",
      id: operation.id,
      updater: (current) => operation.updater(existingOperation.row),
      expectedVersion: Number(existingOperation.row["_version"]),
    };
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
