import type { SheetAdapter, SheetCell } from "../shared/SheetAdapter.js";

export interface AppendRowsInput {
  rows: SheetCell[][];
}

export interface DeleteRowsByKeyInput {
  expectedHeaders: string[];
  keyHeader: string;
  versionHeader: string;
  ids: string[];
  versionsById: Record<string, number>;
}

export interface DeleteRowsByKeyResult {
  deletedRows: Array<{
    id: string;
    cells: SheetCell[];
  }>;
}

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

export interface UpdateRowsByKeyResult {
  updatedRows: Array<{
    id: string;
    cells: SheetCell[];
  }>;
}

export interface DirectSheetAdapter extends SheetAdapter {
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  /**
   * Append one or more rows in one adapter call. Repository writes keep this
   * batch-shaped even when the batch contains one row.
   */
  appendRows?(sheetName: string, input: AppendRowsInput): Promise<void>;
  updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void>;
  /**
   * Update rows by key after validating headers and versions immediately
   * before writing. Gateway adapters should perform this under document lock.
   */
  updateRowsByKey?(
    sheetName: string,
    input: UpdateRowsByKeyInput,
  ): Promise<UpdateRowsByKeyResult>;
  /** Delete one 1-based data row; implementations must reject header deletes. */
  deleteRow(sheetName: string, rowNumber: number): Promise<void>;
  /** Delete multiple 1-based rows in one adapter call when supported. */
  deleteRows?(sheetName: string, rowNumbers: number[]): Promise<void>;
  /**
   * Delete rows by key after validating headers and versions immediately
   * before deleting. Gateway adapters should perform this under document lock.
   */
  deleteRowsByKey?(
    sheetName: string,
    input: DeleteRowsByKeyInput,
  ): Promise<DeleteRowsByKeyResult>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}
