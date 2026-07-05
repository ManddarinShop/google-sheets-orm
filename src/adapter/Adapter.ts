export type SheetCell = string | number | boolean | null;

export interface SheetSnapshot {
  headers: string[];
  rows: SheetRowSnapshot[];
}

export interface SheetRowSnapshot {
  rowNumber: number;
  cells: SheetCell[];
}

export interface SheetAdapter {
  readSheet(sheetName: string): Promise<SheetSnapshot>;
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  /**
   * Append multiple rows in one adapter call when the backing transport supports
   * it. Repository code treats this as an atomic transport optimization: if the
   * method rejects, none of the queued inserts are reported as successful.
   */
  appendRows?(sheetName: string, rows: SheetCell[][]): Promise<void>;
  updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void>;
  /** Delete a 1-based data row. Implementations must reject header-row deletes. */
  deleteRow(sheetName: string, rowNumber: number): Promise<void>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}
