import type { DirectSheetAdapter } from "../../adapter/direct/DirectSheetAdapter.js";
import type { ColumnMap } from "../shared/RepositoryTypes.js";

/**
 * Direct repository write context used by the legacy synchronous executor.
 */
export interface RepositoryWriteContext<
  T extends object,
> {
  adapter: DirectSheetAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
}
