import type {
  AppendRowsInput,
  DeleteRowsByKeyInput,
  DeleteRowsByKeyResult,
  DirectSheetAdapter,
  SheetCell,
  SheetSnapshot,
  UpdateRowsByKeyInput,
  UpdateRowsByKeyResult,
} from "../src/adapter/Adapter.js";
import { ConflictError, SchemaDriftError } from "../src/core/errors/index.js";

export class FakeSheetAdapter implements DirectSheetAdapter {
  private readIndex = 0;

  readonly appendedRows: Array<{ sheetName: string; row: SheetCell[] }> = [];
  readonly appendedRowBatches: Array<{ sheetName: string; rows: SheetCell[][] }> = [];
  readonly ensuredSheets: string[] = [];
  readonly readSheets: string[] = [];
  readonly writtenHeaders: Array<{ sheetName: string; headers: string[] }> = [];
  readonly deletedRows: Array<{ sheetName: string; rowNumber: number }> = [];
  readonly deletedRowBatches: Array<{ sheetName: string; rowNumbers: number[] }> = [];
  readonly deletedRowsByKey: Array<{
    sheetName: string;
    input: DeleteRowsByKeyInput;
  }> = [];
  readonly updatedRows: Array<{
    sheetName: string;
    rowNumber: number;
    row: SheetCell[];
  }> = [];
  readonly updatedRowsByKey: Array<{
    sheetName: string;
    input: UpdateRowsByKeyInput;
  }> = [];
  updateRowsByKey: DirectSheetAdapter["updateRowsByKey"] = async (
    sheetName,
    input,
  ) => updateRowsByKey(this, sheetName, input);
  deleteRowsByKey: DirectSheetAdapter["deleteRowsByKey"] = async (
    sheetName,
    input,
  ) => deleteRowsByKey(this, sheetName, input);

  constructor(
    private readonly sheets:
      | Record<string, SheetSnapshot>
      | Record<string, SheetSnapshot[]>,
  ) {}

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    this.readSheets.push(sheetName);

    const sheetOrSequence = this.sheets[sheetName];
    const sheet = Array.isArray(sheetOrSequence)
      ? sheetOrSequence[
          Math.min(this.readIndex++, sheetOrSequence.length - 1)
        ]
      : sheetOrSequence;

    if (sheet === undefined) {
      throw new Error(`Unknown fake sheet "${sheetName}"`);
    }

    return {
      headers: [...sheet.headers],
      rows: sheet.rows.map(row => ({
        rowNumber: row.rowNumber,
        cells: [...row.cells],
      })),
    };
  }

  async ensureSheet(sheetName: string): Promise<void> {
    this.ensuredSheets.push(sheetName);
  }

  async writeHeader(sheetName: string, headers: string[]): Promise<void> {
    this.writtenHeaders.push({ sheetName, headers: [...headers] });
  }

  async appendRow(sheetName: string, row: SheetCell[]): Promise<void> {
    this.appendedRows.push({ sheetName, row: [...row] });
  }

  async appendRows(sheetName: string, input: AppendRowsInput): Promise<void> {
    this.appendedRowBatches.push({
      sheetName,
      rows: input.rows.map((row) => [...row]),
    });
  }

  async updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void> {
    this.updatedRows.push({ sheetName, rowNumber, row: [...row] });
  }

  async deleteRow(sheetName: string, rowNumber: number): Promise<void> {
    this.deletedRows.push({ sheetName, rowNumber });
  }

  async deleteRows(sheetName: string, rowNumbers: number[]): Promise<void> {
    this.deletedRowBatches.push({
      sheetName,
      rowNumbers: [...rowNumbers],
    });
  }
}

async function updateRowsByKey(
  adapter: FakeSheetAdapter,
  sheetName: string,
  input: UpdateRowsByKeyInput,
): Promise<UpdateRowsByKeyResult> {
  adapter.updatedRowsByKey.push({
    sheetName,
    input: cloneUpdateRowsByKeyInput(input),
  });

  const snapshot = await adapter.readSheet(sheetName);
  const indexes = requireKeyVersionIndexes(snapshot, input);
  const rowsById = collectRowsById(snapshot, indexes.keyIndex);
  const updatedRows = input.updates.map((update) => {
    const target = rowsById.get(update.id);

    if (target === undefined) {
      throw new ConflictError(`Row "${update.id}" changed before update`);
    }

    if (Number(target.cells[indexes.versionIndex]) !== update.expectedVersion) {
      throw new ConflictError(`Stale write for key "${update.id}"`);
    }

    return {
      id: update.id,
      cells: update.row,
    };
  });

  return { updatedRows };
}

async function deleteRowsByKey(
  adapter: FakeSheetAdapter,
  sheetName: string,
  input: DeleteRowsByKeyInput,
): Promise<DeleteRowsByKeyResult> {
  adapter.deletedRowsByKey.push({
    sheetName,
    input: cloneDeleteRowsByKeyInput(input),
  });

  const snapshot = await adapter.readSheet(sheetName);
  const indexes = requireKeyVersionIndexes(snapshot, input);
  const rowsById = collectRowsById(snapshot, indexes.keyIndex);
  const deletedRows = input.ids.map((id) => {
    const target = rowsById.get(id);

    if (target === undefined) {
      throw new ConflictError(`Row "${id}" changed before delete`);
    }

    if (Number(target.cells[indexes.versionIndex]) !== input.versionsById[id]) {
      throw new ConflictError(`Stale delete for key "${id}"`);
    }

    return {
      id,
      cells: target.cells,
    };
  });

  return { deletedRows };
}

function cloneUpdateRowsByKeyInput(
  input: UpdateRowsByKeyInput,
): UpdateRowsByKeyInput {
  return {
    expectedHeaders: [...input.expectedHeaders],
    keyHeader: input.keyHeader,
    versionHeader: input.versionHeader,
    updates: input.updates.map((update) => ({
      id: update.id,
      expectedVersion: update.expectedVersion,
      row: [...update.row],
    })),
  };
}

function cloneDeleteRowsByKeyInput(
  input: DeleteRowsByKeyInput,
): DeleteRowsByKeyInput {
  return {
    expectedHeaders: [...input.expectedHeaders],
    keyHeader: input.keyHeader,
    versionHeader: input.versionHeader,
    ids: [...input.ids],
    versionsById: { ...input.versionsById },
  };
}

function requireKeyVersionIndexes(
  snapshot: SheetSnapshot,
  input: {
    expectedHeaders: string[];
    keyHeader: string;
    versionHeader: string;
  },
): { keyIndex: number; versionIndex: number } {
  input.expectedHeaders.forEach((expectedHeader, index) => {
    if (snapshot.headers[index] !== expectedHeader) {
      throw new SchemaDriftError("Header row changed before write");
    }
  });

  const keyIndex = snapshot.headers.indexOf(input.keyHeader);
  const versionIndex = snapshot.headers.indexOf(input.versionHeader);

  if (keyIndex === -1 || versionIndex === -1) {
    throw new SchemaDriftError("Missing key or version header");
  }

  return { keyIndex, versionIndex };
}

function collectRowsById(
  snapshot: SheetSnapshot,
  keyIndex: number,
): Map<string, { rowNumber: number; cells: SheetCell[] }> {
  const rowsById = new Map<string, { rowNumber: number; cells: SheetCell[] }>();

  for (const row of snapshot.rows) {
    const id = String(row.cells[keyIndex]);

    if (rowsById.has(id)) {
      throw new SchemaDriftError(`Duplicate key "${id}"`);
    }

    rowsById.set(id, row);
  }

  return rowsById;
}
