import type { Column } from "../schema/Columns.js";

/** Column definitions shared by direct and queued repository packages. */
export type ColumnMap<T extends object> = {
  [K in keyof T]: Column<T[K]>;
};
