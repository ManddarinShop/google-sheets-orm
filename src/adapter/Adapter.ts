/**
 * Compatibility barrel for adapter contracts. New internal code should import
 * from `shared/`, `direct/`, or `queued/` according to its write mode.
 */
export type {
  SheetReader,
  SheetAdapter,
  SheetCell,
  SheetRowSnapshot,
  SheetSnapshot,
} from "./shared/index.js";
export type {
  AppendRowsInput,
  DeleteRowsByKeyInput,
  DeleteRowsByKeyResult,
  DirectSheetAdapter,
  UpdateRowsByKeyInput,
  UpdateRowsByKeyResult,
} from "./direct/index.js";
export type {
  AppsScriptQueueAdapter,
  EnqueueTaskInput,
  EnqueueTaskOperation,
  EnqueueTasksInput,
  EnqueueTasksResult,
  InitializeSystemSheetsResult,
  ProcessTaskQueueInput,
  ProcessTaskQueueResult,
} from "./queued/index.js";
