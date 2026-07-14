import type {
  AppendRowsInput,
  DeleteRowsByKeyInput,
  DeleteRowsByKeyResult,
  UpdateRowsByKeyInput,
  UpdateRowsByKeyResult,
} from "./DirectSheetOperations.js";

export type SheetCell = string | number | boolean | null;

export interface SheetSnapshot {
  headers: string[];
  rows: SheetRowSnapshot[];
}

export interface SheetRowSnapshot {
  rowNumber: number;
  cells: SheetCell[];
}

/**
 * Read-only adapter boundary shared by direct and queued repository paths.
 * Queue adapters use this contract because their writes are handled by the
 * task queue rather than by direct row mutations.
 */
export interface SheetReader {
  readSheet(sheetName: string): Promise<SheetSnapshot>;
}

/**
 * Legacy public direct adapter contract.
 *
 * This name historically represented a read/write adapter and remains
 * assignable to direct repositories for source compatibility. New adapter
 * boundaries should use DirectSheetAdapter or SheetReader according to the
 * repository path.
 */
export interface SheetAdapter extends SheetReader {
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  /** Append one or more rows in a single adapter call when supported. */
  appendRows?(sheetName: string, input: AppendRowsInput): Promise<void>;
  updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void>;
  /** Update rows by key with immediate header and version validation. */
  updateRowsByKey?(
    sheetName: string,
    input: UpdateRowsByKeyInput,
  ): Promise<UpdateRowsByKeyResult>;
  /** Delete one 1-based data row; header-row deletes must be rejected. */
  deleteRow(sheetName: string, rowNumber: number): Promise<void>;
  /** Delete multiple 1-based rows in one adapter call when supported. */
  deleteRows?(sheetName: string, rowNumbers: number[]): Promise<void>;
  /** Delete rows by key with immediate header and version validation. */
  deleteRowsByKey?(
    sheetName: string,
    input: DeleteRowsByKeyInput,
  ): Promise<DeleteRowsByKeyResult>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}
