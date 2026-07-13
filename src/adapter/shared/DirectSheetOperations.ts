import type { SheetCell } from "./SheetAdapter.js";

/** Batch input shared by direct adapters and the legacy SheetAdapter contract. */
export interface AppendRowsInput {
  rows: SheetCell[][];
}

/** Optimistic-locking input for deleting rows by repository key. */
export interface DeleteRowsByKeyInput {
  expectedHeaders: string[];
  keyHeader: string;
  versionHeader: string;
  ids: string[];
  versionsById: Record<string, number>;
}

/** Rows removed by a key-based direct delete. */
export interface DeleteRowsByKeyResult {
  deletedRows: Array<{
    id: string;
    cells: SheetCell[];
  }>;
}

/** Optimistic-locking input for updating rows by repository key. */
export interface UpdateRowsByKeyInput {
  expectedHeaders: string[];
  keyHeader: string;
  versionHeader: string;
  updates: Array<{
    id: string;
    expectedVersion: number;
    row: SheetCell[];
  }>;
}

/** Rows updated by a key-based direct update. */
export interface UpdateRowsByKeyResult {
  updatedRows: Array<{
    id: string;
    cells: SheetCell[];
  }>;
}
