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
  /** Reads the visible sheet projection used by the adapter's repository path. */
  readSheet(sheetName: string): Promise<SheetSnapshot>;
}
