import type { AppsScriptQueueAdapter } from "../../../adapter/queued/QueuedSheetAdapter.js";
import type { ColumnMap } from "../../shared/RepositoryTypes.js";

export type QueuedColumnMap<T extends Record<string, unknown>> = ColumnMap<T>;

export interface CreateQueuedSheetRepositoryInput<
  T extends Record<string, unknown>,
> {
  adapter: AppsScriptQueueAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: QueuedColumnMap<T>;
}

/** Public entity-oriented repository contract for queued persistence. */
export interface QueuedSheetRepository<T extends Record<string, unknown>> {
  /** Initializes the gateway-owned canonical, projection, and queue sheets. */
  ensureSheet(): Promise<void>;
  /**
   * Runs entity reads and writes in one queued unit of work. Entity operations
   * outside this callback are not part of the public queued API.
   */
  transaction<TResult>(
    callback: (
      transaction: QueuedRepositoryTransaction<T>,
    ) => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

/** Public transaction callback surface; queue lifecycle stays internal. */
export interface QueuedRepositoryTransaction<
  T extends Record<string, unknown>,
> {
  findAll(): Promise<Array<T>>;
  findById(id: string): Promise<T | null>;
  save(row: T): void;
  remove(row: T): void;
}
