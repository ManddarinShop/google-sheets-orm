import type {
  SheetReader,
  SheetSnapshot,
} from "../shared/SheetAdapter.js";

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
  /** Claims or redactions awaiting recovery before the queue is idle. */
  recoveryPendingTasks?: number;
}

export interface AppsScriptQueueAdapter extends SheetReader {
  /** Reads gateway-owned canonical rows after queued tasks are processed. */
  readCanonicalSheet(sheetName: string): Promise<SheetSnapshot>;
  /**
   * Initializes the visible projection, canonical data, metadata, and task
   * queue sheets used by queued writes.
   */
  initializeSystemSheets(
    sheetName: string,
    headers: string[],
  ): Promise<InitializeSystemSheetsResult>;
  /**
   * Appends one transaction worth of tasks to the durable queue. The caller
   * supplies stable identities so ambiguous responses can be retried safely.
   */
  enqueueTasks(input: EnqueueTasksInput): Promise<EnqueueTasksResult>;
  /** Processes a bounded set of pending queue transaction groups. */
  processTaskQueue(
    input?: ProcessTaskQueueInput,
  ): Promise<ProcessTaskQueueResult>;
}
