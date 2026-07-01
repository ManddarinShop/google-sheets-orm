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
  updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}
