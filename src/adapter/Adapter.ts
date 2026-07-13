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

export interface InitializeSystemSheetsResult {
  logicalSheetName: string;
  canonicalSheetName: string;
  projectionSheetName: string;
  taskQueueSheetName: string;
}

export type EnqueueTaskOperation = "insert" | "update" | "delete";

interface EnqueueTaskBaseInput {
  taskId: string;
  transactionId: string;
  transactionIndex: number;
  sheetName: string;
  keyHeader: string;
  keyValue: string;
  payloadJson: string;
}

export type EnqueueTaskInput =
  | (EnqueueTaskBaseInput & {
      operation: "insert";
      expectedVersion: null;
    })
  | (EnqueueTaskBaseInput & {
      operation: "update" | "delete";
      expectedVersion: number;
    });

export interface EnqueueTasksInput {
  tasks: EnqueueTaskInput[];
}

export interface EnqueueTasksResult {
  tasks: Array<{
    taskId: string;
    sequence: number;
  }>;
}

export interface ProcessTaskQueueInput {
  maxTransactions?: number;
}

export interface ProcessTaskQueueResult {
  processedTransactions: number;
  failedTransactions: number;
  processedTasks: number;
  failedTasks: number;
  remainingPendingTasks: number;
}

export interface SheetAdapter {
  readSheet(sheetName: string): Promise<SheetSnapshot>;
}

export interface DirectSheetAdapter extends SheetAdapter {
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  /**
   * Append one or more rows in one adapter call. Repository writes always flow
   * through this batch-shaped contract, even when the batch contains one row.
   */
  appendRows?(sheetName: string, input: AppendRowsInput): Promise<void>;
  updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void>;
  /**
   * Update rows by key after validating headers and expected versions
   * immediately before writing. Gateway adapters should perform this under the
   * backing document lock.
   */
  updateRowsByKey?(
    sheetName: string,
    input: UpdateRowsByKeyInput,
  ): Promise<UpdateRowsByKeyResult>;
  /** Delete a 1-based data row. Implementations must reject header-row deletes. */
  deleteRow(sheetName: string, rowNumber: number): Promise<void>;
  /**
   * Delete multiple 1-based data rows in one adapter call when supported.
   * Implementations must delete from the bottom row upward so earlier deletes
   * do not shift later row numbers.
   */
  deleteRows?(sheetName: string, rowNumbers: number[]): Promise<void>;
  /**
   * Delete rows by key after validating headers and expected versions
   * immediately before deleting. Gateway adapters should perform this under the
   * backing document lock.
   */
  deleteRowsByKey?(
    sheetName: string,
    input: DeleteRowsByKeyInput,
  ): Promise<DeleteRowsByKeyResult>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}

export interface AppsScriptQueueAdapter extends SheetAdapter {
  /** Reads the gateway-owned canonical rows after queued tasks are processed. */
  readCanonicalSheet(sheetName: string): Promise<SheetSnapshot>;
  /**
   * Initialize the gateway-owned sheet set for queued writes when supported.
   * Implementations should create or reuse the visible projection sheet,
   * canonical data sheet, task queue sheet, and logical-to-canonical mapping.
   */
  initializeSystemSheets(
    sheetName: string,
    headers: string[],
  ): Promise<InitializeSystemSheetsResult>;
  /**
   * Append one transaction worth of write tasks to the internal queue. The
   * gateway assigns monotonic sequence values while the caller supplies stable
   * task and transaction ids for idempotency.
   */
  enqueueTasks(input: EnqueueTasksInput): Promise<EnqueueTasksResult>;
  /**
   * Process a bounded set of pending queue transaction groups into canonical
   * sheets. This is an explicit gateway operation; repository writes do not
   * implicitly process the queue.
   */
  processTaskQueue(
    input?: ProcessTaskQueueInput,
  ): Promise<ProcessTaskQueueResult>;
}
