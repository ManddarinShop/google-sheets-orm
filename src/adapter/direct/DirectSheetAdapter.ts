import type { SheetAdapter } from "../shared/SheetAdapter.js";

export type {
  AppendRowsInput,
  DeleteRowsByKeyInput,
  DeleteRowsByKeyResult,
  UpdateRowsByKeyInput,
  UpdateRowsByKeyResult,
} from "../shared/DirectSheetOperations.js";

/** Direct row-write adapter contract used by the direct repository package. */
export interface DirectSheetAdapter extends SheetAdapter {}
