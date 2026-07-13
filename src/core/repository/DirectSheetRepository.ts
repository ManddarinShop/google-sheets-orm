import type { DirectSheetAdapter } from "../../adapter/Adapter.js";
import { Column } from "../schema/Columns.js";
import { SchemaDriftError } from "../errors/index.js";
import { parseRow, assertSchema } from "../schema/index.js";
import { assertUniqueKeys } from "./RepositoryRowHelpers.js";
import { createRepositoryWriteBatcher } from "./RepositoryWriteBatcher.js";

export type ColumnMap<T extends Record<string, unknown>> = {
  [K in keyof T]: Column<T[K]>;
};

export interface CreateSheetRepositoryInput<T extends Record<string, unknown>> {
  adapter: DirectSheetAdapter;
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
  const writeBatcher = createRepositoryWriteBatcher(input);

  async function ensureSheet(): Promise<void> {
    const headers = Object.keys(columns);

    if (adapter.initializeSheet) {
      await adapter.initializeSheet(sheetName, headers);

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
      await adapter.writeHeader(sheetName, headers);
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
    await writeBatcher.insert(row);
  }

  async function update(
    id: string,
    updater: (current: T) => T,
  ): Promise<T | null> {
    return writeBatcher.update(id, updater);
  }

  // Deletes a row only after re-reading the same sheet row, so stale callers do
  // not remove data that was updated or moved after their first snapshot.
  async function deleteById(id: string): Promise<T | null> {
    return writeBatcher.deleteById(id);
  }

  return { ensureSheet, findAll, findById, insert, update, deleteById };
}
