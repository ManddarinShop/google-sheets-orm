import type { SheetCell } from "../../adapter/shared/SheetAdapter.js";
import { Column } from "./Columns.js";

export type ColumnMap = Record<string, Column<any>>;

export interface ParseRowInput<T extends Record<string, unknown>> {
  headers: string[];
  cells: SheetCell[];
  columns: {
    [K in keyof T]: Column<T[K]>;
  };
}

export function parseRow<T extends Record<string, unknown>>(
  input: ParseRowInput<T>,
): T {
  const { headers, cells, columns } = input;
  const result = {} as T;

  for (const columnName of Object.keys(columns) as Array<keyof T>) {
    const columnIndex = headers.indexOf(String(columnName));
    const cell = columnIndex >= 0 ? cells[columnIndex] ?? null : null;

    result[columnName] = columns[columnName].parse(cell, String(columnName));
  }

  return result;
}
