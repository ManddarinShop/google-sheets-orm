import { ConflictError } from "../../errors/index.js";
import { readRepositoryProperty } from "../../shared/RepositoryRowHelpers.js";
import type { QueuedRepositoryTransaction } from "../public/QueuedRepositoryApi.js";
import type { RepositoryQueueWriteCoordinator } from "./QueuedRepositoryTransactionCoordinator.js";
import type {
  RepositoryWriteTransactionOperation,
} from "../writer/QueuedSheetWriteExecutor.js";

export interface InternalQueuedRepositoryTransactionScope<
  T extends object,
> extends QueuedRepositoryTransaction<T> {
  flush(): Promise<Array<void | T | null>>;
  /** Re-enqueues an ambiguous batch without reading the current sheet. */
  retry(): Promise<Array<void | T | null>>;
  clear(): void;
  /** Closes the scope so escaped transaction handles cannot mutate later. */
  close(): void;
}

export interface CreateQueuedRepositoryTransactionScopeInput<
  T extends object,
> {
  findAll(): Promise<Array<T>>;
  key: keyof T & string;
  writeCoordinator: RepositoryQueueWriteCoordinator<T>;
  transactionId?: string;
}

/**
 * Creates the explicit unit of work used by the public transaction callback.
 * Reads and mutations stay together until flush materializes one queue batch.
 */
export function createQueuedRepositoryTransactionScope<
  T extends object,
>(
  input: CreateQueuedRepositoryTransactionScopeInput<T>,
): InternalQueuedRepositoryTransactionScope<T> {
  const pendingOperations: Array<RepositoryWriteTransactionOperation<T>> = [];
  const knownEntityIds = new Set<string>();
  const loadedEntityKeys = new WeakMap<object, string>();
  let inFlightOperations: Array<RepositoryWriteTransactionOperation<T>> | null =
    null;
  let inFlightTransactionId: string | null = input.transactionId ?? null;
  let closed = false;

  function assertScopeOpen(): void {
    if (closed) {
      throw new ConflictError(
        "Queued repository transaction scope is closed",
      );
    }
  }

  function save(row: T): void {
    assertScopeOpen();
    const currentKey = String(row[input.key]);
    const originalKey = loadedEntityKeys.get(row);

    assertEntityKeyUnchanged(originalKey, currentKey);

    const rowSnapshot = cloneRow(row);
    const isKnownEntity = originalKey !== undefined
      || knownEntityIds.has(currentKey);

    pushPendingOperation(
      isKnownEntity
        ? {
            kind: "save",
            row: rowSnapshot,
            requireExisting: true,
          }
        : {
            kind: "insert",
            row: rowSnapshot,
          },
    );

    // Keep the original identity on entities introduced directly to this
    // transaction as well as entities read from the canonical sheet. Without
    // this, mutating a newly saved entity's key before a second save could
    // turn the second save into an unrelated insert.
    if (originalKey === undefined) {
      loadedEntityKeys.set(row, currentKey);
    }
  }

  function remove(row: T): void {
    assertScopeOpen();
    const currentKey = String(row[input.key]);
    const originalKey = loadedEntityKeys.get(row);

    assertEntityKeyUnchanged(originalKey, currentKey);

    const rowSnapshot = cloneRow(row);

    pushPendingOperation({
      kind: "delete",
      id: String(rowSnapshot[input.key]),
      expectedVersion: Number(
        readRepositoryProperty(rowSnapshot, "_version"),
      ),
    });
  }

  /**
   * Materializes the collected operations and appends one transaction group to
   * the durable task queue. Enqueue failures retain the internal retry batch.
   */
  async function flush(): Promise<Array<void | T | null>> {
    assertScopeOpen();

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
    assertScopeOpen();

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

  function close(): void {
    closed = true;
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
    assertScopeOpen();
    const rows = await input.findAll();

    for (const row of rows) {
      const entityKey = String(row[input.key]);

      rememberCanonicalEntity(row, entityKey);
    }

    const rowsById = new Map(rows.map((row) => [String(row[input.key]), row]));

    for (const operation of pendingOperations) {
      if (operation.kind === "insert" || operation.kind === "save") {
        const overlayRow = cloneRow(operation.row);
        rememberOverlayEntity(overlayRow, String(overlayRow[input.key]));
        rowsById.set(String(overlayRow[input.key]), overlayRow);
        continue;
      }

      if (operation.kind === "update") {
        const currentRow = rowsById.get(operation.id);

        if (currentRow === undefined) {
          continue;
        }

        const overlayRow = cloneRow(operation.updater(currentRow));
        rememberOverlayEntity(overlayRow, operation.id);
        rowsById.set(operation.id, overlayRow);
        continue;
      }

      rowsById.delete(operation.id);
    }

    return [...rowsById.values()];
  }

  function rememberCanonicalEntity(row: T, entityKey: string): void {
    knownEntityIds.add(entityKey);
    loadedEntityKeys.set(row, entityKey);
  }

  function rememberOverlayEntity(row: T, entityKey: string): void {
    loadedEntityKeys.set(row, entityKey);
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
    close,
  };
}

function assertEntityKeyUnchanged(
  originalKey: string | undefined,
  currentKey: string,
): void {
  if (originalKey !== undefined && originalKey !== currentKey) {
    throw new ConflictError(
      `Entity key cannot be changed from "${originalKey}" to "${currentKey}"`,
    );
  }
}

function cloneRow<T extends object>(row: T): T {
  return { ...row };
}

function getPendingOperationId<T extends object>(
  operation: RepositoryWriteTransactionOperation<T>,
  key: keyof T & string,
): string {
  if (operation.kind === "insert" || operation.kind === "save") {
    return String(operation.row[key]);
  }

  return operation.id;
}

function mergePendingOperations<T extends object>(input: {
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
      updater: () => operation.updater(existingOperation.row),
      expectedVersion: Number(
        readRepositoryProperty(existingOperation.row, "_version"),
      ),
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

function withExpectedVersion<T extends object>(
  operation: Extract<RepositoryWriteTransactionOperation<T>, { kind: "update" }>,
  expectedVersion: number | undefined,
): Extract<RepositoryWriteTransactionOperation<T>, { kind: "update" }> {
  return expectedVersion === undefined
    ? operation
    : { ...operation, expectedVersion };
}
