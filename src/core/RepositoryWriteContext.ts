import type { DirectSheetAdapter } from "../adapter/Adapter.js";
import type { ColumnMap } from "./Repository.js";

/**
 * Direct repository write context used by the legacy synchronous executor.
 */
export interface RepositoryWriteContext<
  T extends Record<string, unknown>,
> {
  adapter: DirectSheetAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
}
