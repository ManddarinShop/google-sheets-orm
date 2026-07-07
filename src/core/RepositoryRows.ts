import type { SheetCell, SheetRowSnapshot } from "../adapter/Adapter.js";
import type { ColumnMap } from "./Repository.js";
import { SchemaDriftError } from "./Errors.js";
import { parseRow } from "./RowParser.js";

export interface ParsedRepositoryRow<T extends Record<string, unknown>> {
  rowNumber: number;
  cells: SheetCell[];
  row: T;
}

/**
 * Parses raw sheet rows once into both typed rows and original cells. Write
 * batchers use the original cells to preserve columns outside the schema.
 */
export function parseRepositoryRows<T extends Record<string, unknown>>(input: {
  headers: string[];
  sheetRows: SheetRowSnapshot[];
  columns: ColumnMap<T>;
}): Array<ParsedRepositoryRow<T>> {
  const { headers, sheetRows, columns } = input;

  return sheetRows.map((sheetRow) => ({
    rowNumber: sheetRow.rowNumber,
    cells: sheetRow.cells,
    row: parseRow<T>({
      headers,
      cells: sheetRow.cells,
      columns,
    }),
  }));
}

/**
 * Converts cells returned by write-capable adapters back into repository rows.
 * This keeps fast-path results aligned with what the adapter actually changed.
 */
export function parseAdapterResultRow<T extends Record<string, unknown>>(input: {
  headers: string[];
  cells: SheetCell[];
  columns: ColumnMap<T>;
}): T {
  return parseRow<T>(input);
}

/**
 * Fails when parsed repository rows contain duplicate key values. Duplicate keys
 * make update/delete target selection ambiguous and are treated as schema drift.
 */
export function assertUniqueKeys<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T & string,
): void {
  const seen = new Set<string>();

  for (const row of rows) {
    const keyValue = String(row[key]);

    if (seen.has(keyValue)) {
      throw new SchemaDriftError(`Duplicate key "${keyValue}"`);
    }

    seen.add(keyValue);
  }
}

/**
 * Finds a parsed repository row by key value, returning null when the current
 * snapshot does not contain the requested id.
 */
export function findParsedRowByIdOrNull<T extends Record<string, unknown>>(
  input: {
    parsedRows: Array<ParsedRepositoryRow<T>>;
    key: keyof T & string;
    id: string;
  },
): ParsedRepositoryRow<T> | null {
  const { parsedRows, key, id } = input;

  return (
    parsedRows.find((parsedRow) => String(parsedRow.row[key]) === id) ?? null
  );
}

/**
 * Finds a raw sheet row by its 1-based row number. Fallback write paths use this
 * to verify that the same physical row still exists before writing.
 */
export function findSheetRowByNumberOrNull(
  rows: SheetRowSnapshot[],
  rowNumber: number,
): SheetRowSnapshot | null {
  return rows.find((sheetRow) => sheetRow.rowNumber === rowNumber) ?? null;
}

/**
 * Serializes modeled columns in sheet header order. Unknown sheet headers are
 * omitted, which is appropriate for appending new rows.
 */
export function serializeRowInHeaderOrder<T extends Record<string, unknown>>(
  input: {
    headers: string[];
    row: T;
    columns: ColumnMap<T>;
  },
): SheetCell[] {
  const { headers, row, columns } = input;

  return headers
    .filter((header) => header in columns)
    .map((header) => {
      const columnName = header as keyof T;
      return columns[columnName].serialize(row[columnName]);
    });
}

/**
 * Serializes an update row while preserving cells for headers outside the
 * repository schema, so allowed extra sheet columns are not overwritten.
 */
export function serializeRowPreservingUnknownCells<
  T extends Record<string, unknown>,
>(input: {
  headers: string[];
  existingCells: SheetCell[];
  row: T;
  columns: ColumnMap<T>;
}): SheetCell[] {
  const { headers, existingCells, row, columns } = input;

  return headers.map((header, index) => {
    if (!(header in columns)) {
      return existingCells[index] ?? null;
    }

    const columnName = header as keyof T;
    return columns[columnName].serialize(row[columnName]);
  });
}
