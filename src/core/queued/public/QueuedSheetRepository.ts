import type { AppsScriptQueueAdapter } from "../../../adapter/queued/QueuedSheetAdapter.js";
import type { SheetSnapshot } from "../../../adapter/shared/SheetAdapter.js";
import { parseRow, assertSchema } from "../../schema/index.js";
import { assertUniqueKeys } from "../../shared/RepositoryRowHelpers.js";
import {
  createQueuedRepositoryTransactionCoordinator,
} from "../transaction/QueuedRepositoryTransactionCoordinator.js";
import {
  createRepositoryQueueWriteExecutor,
} from "../writer/QueuedSheetWriteExecutor.js";
import {
  createQueuedRepositoryTransactionScope,
  type InternalQueuedRepositoryTransactionScope,
} from "../transaction/QueuedRepositoryTransactionScope.js";
import type {
  CreateQueuedSheetRepositoryInput,
  QueuedRepositoryTransaction,
  QueuedSheetRepository,
} from "./QueuedRepositoryApi.js";

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
  const writeCoordinator = createQueuedRepositoryTransactionCoordinator({
    executor: createRepositoryQueueWriteExecutor(input),
  });

  async function ensureSheet(): Promise<void> {
    await adapter.initializeSystemSheets(sheetName, Object.keys(columns));
  }

  /** Reads canonical rows for the current transaction scope. */
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

  /** Creates the one unit of work used by a manual or future ambient transaction. */
  function createRepositoryTransactionScope():
    InternalQueuedRepositoryTransactionScope<T> {
    return createQueuedRepositoryTransactionScope({
      findAll,
      key,
      writeCoordinator,
    });
  }

  /**
   * Runs all entity reads and writes in one queued unit of work. Callback
   * failures are cleared; enqueue failures retain their internal retry batch.
   */
  async function transaction<TResult>(
    callback: (
      transaction: QueuedRepositoryTransaction<T>,
    ) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const transactionScope = createRepositoryTransactionScope();
    let result: TResult;

    try {
      result = await callback(transactionScope);
    } catch (error) {
      transactionScope.clear();
      throw error;
    }

    await transactionScope.flush();
    return result;
  }

  return {
    ensureSheet,
    transaction,
  };
}

function readQueuedRepositorySheet(
  adapter: AppsScriptQueueAdapter,
  sheetName: string,
): Promise<SheetSnapshot> {
  return adapter.readCanonicalSheet(sheetName);
}
