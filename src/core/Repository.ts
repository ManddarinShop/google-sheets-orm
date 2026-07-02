import {
  type SheetAdapter,
  type SheetCell,
  type SheetRowSnapshot,
} from "../adapter/Adapter.js";
import { Column } from "./Columns.js";
import { ConflictError, SchemaDriftError } from "./Errors.js";
import { parseRow } from "./RowParser.js";
import { assertSchema } from "./Schema.js";

export type ColumnMap<T extends Record<string, unknown>> = {
  [K in keyof T]: Column<T[K]>;
};

export interface CreateSheetRepositoryInput<T extends Record<string, unknown>> {
  adapter: SheetAdapter;
  sheetName: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
}

export interface SheetRepository<T extends Record<string, unknown>> {
  ensureSheet(): Promise<void>;
  findAll(): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  insert(row: T): Promise<void>;
  update(id: string, updater: (current: T) => T): Promise<T | null>;
  deleteById(id: string): Promise<T | null>;
}

export function createSheetRepository<T extends Record<string, unknown>>(
  input: CreateSheetRepositoryInput<T>,
): SheetRepository<T> {
  const { adapter, sheetName, key, columns } = input;

  async function ensureSheet(): Promise<void> {
    if (adapter.initializeSheet) {
      await adapter.initializeSheet(sheetName, Object.keys(columns));

      const snapshot = await adapter.readSheet(sheetName);

      assertSchema({
        headers: snapshot.headers,
        key,
        columns,
      });

      return;
    }

    if (
      adapter.ensureSheet === undefined ||
      adapter.writeHeader === undefined
    ) {
      throw new SchemaDriftError(
        "Adapter does not support automatic sheet initialization",
      );
    }

    await adapter.ensureSheet(sheetName);

    const snapshot = await adapter.readSheet(sheetName);

    if (snapshot.headers.length === 0) {
      await adapter.writeHeader(sheetName, Object.keys(columns));
      return;
    }

    assertSchema({
      headers: snapshot.headers,
      key,
      columns,
    });
  }

  async function findAll(): Promise<T[]> {
    const snapshot = await adapter.readSheet(sheetName);

    assertSchema({
      headers: snapshot.headers,
      key,
      columns,
    });

    const rows = snapshot.rows.map((row) =>
      parseRow<T>({
        headers: snapshot.headers,
        cells: row.cells,
        columns,
      }),
    );

    assertUniqueKeys(rows, key);

    return rows;
  }

  async function findById(id: string): Promise<T | null> {
    const rows = await findAll();

    return rows.find((row) => String(row[key]) === id) ?? null;
  }

  async function insert(row: T): Promise<void> {
    const snapshot = await adapter.readSheet(sheetName);

    assertSchema({
      headers: snapshot.headers,
      key,
      columns,
    });

    const existingRows = snapshot.rows.map((sheetRow) =>
      parseRow<T>({
        headers: snapshot.headers,
        cells: sheetRow.cells,
        columns,
      }),
    );

    assertUniqueKeys(existingRows, key);

    const keyValue = String(row[key]);

    if (
      existingRows.some(
        (existingRows) => String(existingRows[key]) === keyValue,
      )
    ) {
      throw new SchemaDriftError(`Duplicate key "${keyValue}"`);
    }

    const serializedRow = serializeRowInHeaderOrder({
      headers: snapshot.headers,
      row,
      columns,
    });

    await adapter.appendRow(sheetName, serializedRow);
  }

  async function update(
    id: string,
    updater: (current: T) => T,
  ): Promise<T | null> {
    const snapshot = await adapter.readSheet(sheetName);

    assertSchema({
      headers: snapshot.headers,
      key,
      columns,
    });

    const parsedRows = snapshot.rows.map((sheetRow) => ({
      rowNumber: sheetRow.rowNumber,
      row: parseRow<T>({
        headers: snapshot.headers,
        cells: sheetRow.cells,
        columns,
      }),
    }));

    assertUniqueKeys(
      parsedRows.map((parsedRow) => parsedRow.row),
      key,
    );

    const target = findParsedRowByIdOrNull({
      parsedRows,
      key,
      id,
    });

    if (target === null) {
      return null;
    }

    const currentVersion = Number(target.row["_version"]);

    const updateRow = {
      ...updater(target.row),
      _version: currentVersion + 1,
    } as T;

    const latestSnapshot = await adapter.readSheet(sheetName);

    assertSchema({
      headers: latestSnapshot.headers,
      key,
      columns,
    });

    const latestSheetRow = findSheetRowByNumberOrNull(
      latestSnapshot.rows,
      target.rowNumber,
    );

    if (latestSheetRow === null) {
      throw new ConflictError(`Row "${id}" changed before update`);
    }

    const latestRow = parseRow<T>({
      headers: latestSnapshot.headers,
      cells: latestSheetRow.cells,
      columns,
    });

    if (Number(latestRow["_version"]) !== currentVersion) {
      throw new ConflictError(`Stale write for key "${id}"`);
    }

    const serializedRow = serializeRowInHeaderOrder({
      headers: snapshot.headers,
      row: updateRow,
      columns,
    });

    await adapter.updateRow(sheetName, target.rowNumber, serializedRow);

    return updateRow;
  }

  // Deletes a row only after re-reading the same sheet row, so stale callers do
  // not remove data that was updated or moved after their first snapshot.
  async function deleteById(id: string): Promise<T | null> {
    const snapshot = await adapter.readSheet(sheetName);

    assertSchema({
      headers: snapshot.headers,
      key,
      columns,
    });

    const parsedRows = snapshot.rows.map((sheetRow) => ({
      rowNumber: sheetRow.rowNumber,
      row: parseRow<T>({
        headers: snapshot.headers,
        cells: sheetRow.cells,
        columns,
      }),
    }));

    assertUniqueKeys(
      parsedRows.map((parsedRow) => parsedRow.row),
      key,
    );

    const target = findParsedRowByIdOrNull({
      parsedRows,
      key,
      id,
    });

    if (target === null) {
      return null;
    }

    const currentVersion = Number(target.row["_version"]);
    const latestSnapshot = await adapter.readSheet(sheetName);

    assertSchema({
      headers: latestSnapshot.headers,
      key,
      columns,
    });

    const latestSheetRow = findSheetRowByNumberOrNull(
      latestSnapshot.rows,
      target.rowNumber,
    );

    if (latestSheetRow === null) {
      throw new ConflictError(`Row "${id}" changed before delete`);
    }

    const latestRow = parseRow<T>({
      headers: latestSnapshot.headers,
      cells: latestSheetRow.cells,
      columns,
    });

    if (
      String(latestRow[key]) !== id ||
      Number(latestRow["_version"]) !== currentVersion
    ) {
      throw new ConflictError(`Stale delete for key "${id}"`);
    }

    await adapter.deleteRow(sheetName, target.rowNumber);

    return target.row;
  }

  return { ensureSheet, findAll, findById, insert, update, deleteById };
}

function assertUniqueKeys<T extends Record<string, unknown>>(
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

function findParsedRowByIdOrNull<T extends Record<string, unknown>>(input: {
  parsedRows: Array<{ rowNumber: number; row: T }>;
  key: keyof T & string;
  id: string;
}): { rowNumber: number; row: T } | null {
  const { parsedRows, key, id } = input;

  return (
    parsedRows.find((parsedRow) => String(parsedRow.row[key]) === id) ?? null
  );
}

function findSheetRowByNumberOrNull(
  rows: SheetRowSnapshot[],
  rowNumber: number,
): SheetRowSnapshot | null {
  return rows.find((sheetRow) => sheetRow.rowNumber === rowNumber) ?? null;
}

function serializeRowInHeaderOrder<T extends Record<string, unknown>>(input: {
  headers: string[];
  row: T;
  columns: ColumnMap<T>;
}): SheetCell[] {
  const { headers, row, columns } = input;

  return headers
    .filter((header) => header in columns)
    .map((header) => {
      const columnName = header as keyof T;
      return columns[columnName].serialize(row[columnName]);
    });
}
