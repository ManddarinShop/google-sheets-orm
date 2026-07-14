import type { AppsScriptQueueAdapter } from "../../../adapter/queued/QueuedSheetAdapter.js";
import type { ColumnMap } from "../../shared/RepositoryTypes.js";
import type { QueuedRepositoryReadCacheOptions } from "../cache/QueuedRepositoryReadCache.js";

export type { QueuedRepositoryReadCacheOptions } from "../cache/QueuedRepositoryReadCache.js";

export type QueuedColumnMap<T extends object> = ColumnMap<T>;

export interface CreateQueuedSheetRepositoryInput<
  T extends object,
> {
  adapter: AppsScriptQueueAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: QueuedColumnMap<T>;
  /** Optional repository-local cache for confirmed canonical reads. */
  cache?: QueuedRepositoryReadCacheOptions;
}

/** Public queued repository contract with an explicit transaction boundary. */
export interface QueuedSheetRepository<T extends object> {
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
  T extends object,
> {
  findAll(): Promise<Array<T>>;
  findById(id: string): Promise<T | null>;
  save(row: T): void;
  remove(row: T): void;
}
