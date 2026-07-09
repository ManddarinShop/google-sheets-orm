import type { DirectSheetAdapter } from "../adapter/Adapter.js";
import type { ColumnMap } from "./Repository.js";

/**
 * Shared repository write context used by insert, update, and delete batchers.
 * Future write executors, such as a sheet task queue, can reuse this boundary.
 */
export interface RepositoryWriteBatcherContext<
  T extends Record<string, unknown>,
> {
  adapter: DirectSheetAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
}
