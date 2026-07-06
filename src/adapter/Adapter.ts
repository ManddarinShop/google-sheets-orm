export type SheetCell = string | number | boolean | null;

export interface SheetSnapshot {
  headers: string[];
  rows: SheetRowSnapshot[];
}

export interface SheetRowSnapshot {
  rowNumber: number;
  cells: SheetCell[];
}

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

export interface SheetAdapter {
  readSheet(sheetName: string): Promise<SheetSnapshot>;
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  /**
   * Append multiple rows in one adapter call when the backing transport supports
   * it. Repository code treats this as an atomic transport optimization: if the
   * method rejects, none of the queued inserts are reported as successful.
   */
  appendRows?(sheetName: string, input: AppendRowsInput): Promise<void>;
  updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void>;
  /** Delete a 1-based data row. Implementations must reject header-row deletes. */
  deleteRow(sheetName: string, rowNumber: number): Promise<void>;
  /**
   * Delete multiple 1-based data rows in one adapter call when supported.
   * Implementations must delete from the bottom row upward so earlier deletes
   * do not shift later row numbers.
   */
  deleteRows?(sheetName: string, rowNumbers: number[]): Promise<void>;
  /**
   * Delete rows by key under one transport-level lock when supported. The
   * adapter validates the key and version immediately before deleting so the
   * repository can avoid an extra readSheet round trip.
   */
  deleteRowsByKey?(
    sheetName: string,
    input: DeleteRowsByKeyInput,
  ): Promise<DeleteRowsByKeyResult>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}
