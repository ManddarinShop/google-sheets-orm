import type { AppsScriptQueueAdapter } from "../../../adapter/queued/QueuedSheetAdapter.js";
import type { SheetSnapshot } from "../../../adapter/shared/SheetAdapter.js";
import { assertSchema } from "../../schema/index.js";
import {
  assertUniqueKeys,
  parseRepositoryRows,
} from "../../shared/RepositoryRowHelpers.js";
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
import type { RepositorySnapshot } from "../writer/QueuedSheetWriteExecutor.js";
import type {
  CreateQueuedSheetRepositoryInput,
  QueuedRepositoryTransaction,
  QueuedSheetRepository,
} from "./QueuedRepositoryApi.js";

/**
 * Creates the queued repository facade. Entity reads and writes are available
 * only through the transaction callback so one service operation has one
 * explicit unit of work and one queue transaction.
 */
export function createQueuedSheetRepository<
  T extends object,
>(
  input: CreateQueuedSheetRepositoryInput<T>,
): QueuedSheetRepository<T> {
  const { adapter, sheetName, key, columns } = input;
  const writeCoordinator = createQueuedRepositoryTransactionCoordinator({
    executor: createRepositoryQueueWriteExecutor(input),
  });

  async function ensureSheet(): Promise<void> {
    const headers = Object.keys(columns);

    // Validate the queued repository contract before asking the gateway to
    // create system sheets. This keeps missing key/version columns from
    // appearing to initialize successfully and failing only on first use.
    assertSchema({
      headers,
      key,
      columns,
    });

    await adapter.initializeSystemSheets(sheetName, headers);
  }

  /** Reads and validates one canonical snapshot for a transaction scope. */
  async function readSnapshot(): Promise<RepositorySnapshot<T>> {
    const snapshot = await readQueuedRepositorySheet(adapter, sheetName);

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

  /** Creates the one unit of work used by a manual or future ambient transaction. */
  function createRepositoryTransactionScope():
    InternalQueuedRepositoryTransactionScope<T> {
    return createQueuedRepositoryTransactionScope({
      readSnapshot,
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
      transactionScope.close();
      throw error;
    }

    try {
      await transactionScope.flush();
    } finally {
      transactionScope.close();
    }

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
