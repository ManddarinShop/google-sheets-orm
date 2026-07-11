import type { SheetCell } from "../../adapter/Adapter.js";
import { ConflictError } from "../errors/index.js";
import type { RepositoryWriteContext } from "./DirectSheetWriteContext.js";
import {
  assertUniqueKeys,
  findParsedRowByIdOrNull,
  parseAdapterResultRow,
  parseRepositoryRows,
  serializeRowInHeaderOrder,
  serializeRowPreservingUnknownCells,
  type ParsedRepositoryRow,
} from "../repository/RepositoryRowHelpers.js";
import { assertSchema } from "../schema/index.js";

interface RepositoryUpdateRequest<T extends Record<string, unknown>> {
  id: string;
  updater(current: T): T;
}

interface RepositorySyncWriteExecutor<T extends Record<string, unknown>> {
  insertRows(rows: Array<T>): Promise<Array<void>>;
  updateRowsById(
    requests: Array<RepositoryUpdateRequest<T>>,
  ): Promise<Array<T | null>>;
  deleteRowsById(ids: Array<string>): Promise<Array<T | null>>;
}

interface ResolvedUpdate<T extends Record<string, unknown>> {
  id: string;
  currentVersion: number;
  target: ParsedRepositoryRow<T>;
  row: T;
  serializedRow: Array<SheetCell>;
}

interface RepositorySnapshot<T extends Record<string, unknown>> {
  headers: Array<string>;
  parsedRows: Array<ParsedRepositoryRow<T>>;
}

/**
 * Creates the strict synchronous write executor. It preserves today's sheet
 * semantics while giving the repository batcher a replaceable executor boundary
 * for future queue/cache write engines.
 */
export function createRepositorySyncWriteExecutor<
  T extends Record<string, unknown>,
>(
  input: RepositoryWriteContext<T>,
): RepositorySyncWriteExecutor<T> {
  return {
    insertRows: (rows) => insertRepositoryRows(input, rows),
    updateRowsById: (requests) => updateRepositoryRowsById(input, requests),
    deleteRowsById: (ids) => deleteRepositoryRowsById(input, ids),
  };
}

async function insertRepositoryRows<T extends Record<string, unknown>>(
  input: RepositoryWriteContext<T>,
  rows: Array<T>,
): Promise<Array<void>> {
  const { adapter, sheetName, key, columns } = input;

  if (rows.length === 0) {
    return [];
  }

  const snapshot = await readRepositorySnapshot(input);
  const existingRows = snapshot.parsedRows.map((parsedRow) => parsedRow.row);

  assertUniqueKeys([...existingRows, ...rows], key);

  const serializedRows = rows.map((row) =>
    serializeRowInHeaderOrder({
      headers: snapshot.headers,
      row,
      columns,
    }),
  );

  if (adapter.appendRows !== undefined) {
    await adapter.appendRows(sheetName, { rows: serializedRows });
  } else {
    for (const serializedRow of serializedRows) {
      await adapter.appendRow(sheetName, serializedRow);
    }
  }

  return createVoidResults(rows.length);
}

async function updateRepositoryRowsById<T extends Record<string, unknown>>(
  input: RepositoryWriteContext<T>,
  requests: Array<RepositoryUpdateRequest<T>>,
): Promise<Array<T | null>> {
  const { adapter, sheetName, key, columns } = input;

  if (requests.length === 0) {
    return [];
  }

  const snapshot = await readRepositorySnapshot(input);

  const claimedIds = new Set<string>();
  const resolvedUpdates = requests.map((request) => {
    if (claimedIds.has(request.id)) {
      throw new ConflictError(`Duplicate update for key "${request.id}"`);
    }

    const target = findParsedRowByIdOrNull({
      parsedRows: snapshot.parsedRows,
      key,
      id: request.id,
    });

    if (target === null) {
      return null;
    }

    claimedIds.add(request.id);

    const currentVersion = Number(target.row["_version"]);
    const row = {
      ...request.updater(target.row),
      _version: currentVersion + 1,
    } as T;

    return {
      id: request.id,
      currentVersion,
      target,
      row,
      serializedRow: serializeRowPreservingUnknownCells({
        headers: snapshot.headers,
        existingCells: target.cells,
        row,
        columns,
      }),
    };
  });

  const rowsToUpdate = resolvedUpdates.filter(
    (update): update is ResolvedUpdate<T> => update !== null,
  );

  if (rowsToUpdate.length === 0) {
    return requests.map(() => null);
  }

  if (adapter.updateRowsByKey !== undefined) {
    return applyLockedKeyBasedUpdates({
      input,
      snapshot,
      resolvedUpdates,
      rowsToUpdate,
    });
  }

  return applyDirectRowNumberUpdates({
    input,
    resolvedUpdates,
    rowsToUpdate,
  });
}

async function deleteRepositoryRowsById<T extends Record<string, unknown>>(
  input: RepositoryWriteContext<T>,
  ids: Array<string>,
): Promise<Array<T | null>> {
  const { adapter, sheetName, key, columns } = input;

  if (ids.length === 0) {
    return [];
  }

  const snapshot = await readRepositorySnapshot(input);

  const claimedIds = new Set<string>();
  const targets = ids.map((id) => {
    if (claimedIds.has(id)) {
      return null;
    }

    const target = findParsedRowByIdOrNull({
      parsedRows: snapshot.parsedRows,
      key,
      id,
    });

    if (target !== null) {
      claimedIds.add(id);
    }

    return target;
  });

  const rowsToDelete = targets.filter(
    (target): target is ParsedRepositoryRow<T> => target !== null,
  );

  if (rowsToDelete.length === 0) {
    return ids.map(() => null);
  }

  if (adapter.deleteRowsByKey !== undefined) {
    return applyLockedKeyBasedDeletes({
      input,
      snapshot,
      targets,
      rowsToDelete,
    });
  }

  return applyDirectRowNumberDeletes({
    input,
    targets,
    rowsToDelete,
  });
}

async function applyLockedKeyBasedUpdates<T extends Record<string, unknown>>(
  params: {
    input: RepositoryWriteContext<T>;
    snapshot: RepositorySnapshot<T>;
    resolvedUpdates: Array<ResolvedUpdate<T> | null>;
    rowsToUpdate: Array<ResolvedUpdate<T>>;
  },
): Promise<Array<T | null>> {
  const { input, snapshot, resolvedUpdates, rowsToUpdate } = params;
  const { adapter, sheetName, key, columns } = input;

  if (adapter.updateRowsByKey === undefined) {
    throw new Error("Adapter does not support locked key-based updates");
  }

  const updateResult = await adapter.updateRowsByKey(sheetName, {
    expectedHeaders: snapshot.headers,
    keyHeader: key,
    versionHeader: "_version",
    updates: rowsToUpdate.map((update) => ({
      id: update.id,
      expectedVersion: update.currentVersion,
      row: update.serializedRow,
    })),
  });
  const updatedRowsById = new Map(
    updateResult.updatedRows.map((updatedRow) => [
      updatedRow.id,
      parseAdapterResultRow<T>({
        headers: snapshot.headers,
        cells: updatedRow.cells,
        columns,
      }),
    ]),
  );

  for (const update of rowsToUpdate) {
    if (!updatedRowsById.has(update.id)) {
      throw new ConflictError(`Row "${update.id}" changed before update`);
    }
  }

  return resolvedUpdates.map((update) =>
    update === null ? null : updatedRowsById.get(update.id) as T,
  );
}

async function applyDirectRowNumberUpdates<T extends Record<string, unknown>>(
  params: {
    input: RepositoryWriteContext<T>;
    resolvedUpdates: Array<ResolvedUpdate<T> | null>;
    rowsToUpdate: Array<ResolvedUpdate<T>>;
  },
): Promise<Array<T | null>> {
  const { input, resolvedUpdates, rowsToUpdate } = params;
  const { adapter, sheetName } = input;
  const latestSnapshot = await readRepositorySnapshot(input);

  for (const update of rowsToUpdate) {
    const latestSheetRow = findParsedRowByNumberOrNull(
      latestSnapshot.parsedRows,
      update.target.rowNumber,
    );

    if (latestSheetRow === null) {
      throw new ConflictError(`Row "${update.id}" changed before update`);
    }

    if (Number(latestSheetRow.row["_version"]) !== update.currentVersion) {
      throw new ConflictError(`Stale write for key "${update.id}"`);
    }
  }

  for (const update of rowsToUpdate) {
    await adapter.updateRow(
      sheetName,
      update.target.rowNumber,
      update.serializedRow,
    );
  }

  return resolvedUpdates.map((update) => update?.row ?? null);
}

async function applyLockedKeyBasedDeletes<T extends Record<string, unknown>>(
  params: {
    input: RepositoryWriteContext<T>;
    snapshot: RepositorySnapshot<T>;
    targets: Array<ParsedRepositoryRow<T> | null>;
    rowsToDelete: Array<ParsedRepositoryRow<T>>;
  },
): Promise<Array<T | null>> {
  const { input, snapshot, targets, rowsToDelete } = params;
  const { adapter, sheetName, key, columns } = input;

  if (adapter.deleteRowsByKey === undefined) {
    throw new Error("Adapter does not support locked key-based deletes");
  }

  const deleteResult = await adapter.deleteRowsByKey(sheetName, {
    expectedHeaders: snapshot.headers,
    keyHeader: key,
    versionHeader: "_version",
    ids: rowsToDelete.map((target) => String(target.row[key])),
    versionsById: Object.fromEntries(
      rowsToDelete.map((target) => [
        String(target.row[key]),
        Number(target.row["_version"]),
      ]),
    ),
  });
  const deletedRowsById = new Map(
    deleteResult.deletedRows.map((deletedRow) => [
      deletedRow.id,
      parseAdapterResultRow<T>({
        headers: snapshot.headers,
        cells: deletedRow.cells,
        columns,
      }),
    ]),
  );

  for (const target of rowsToDelete) {
    const id = String(target.row[key]);

    if (!deletedRowsById.has(id)) {
      throw new ConflictError(`Row "${id}" changed before delete`);
    }
  }

  return targets.map((target) =>
    target === null
      ? null
      : deletedRowsById.get(String(target.row[key])) ?? null,
  );
}

async function applyDirectRowNumberDeletes<T extends Record<string, unknown>>(
  params: {
    input: RepositoryWriteContext<T>;
    targets: Array<ParsedRepositoryRow<T> | null>;
    rowsToDelete: Array<ParsedRepositoryRow<T>>;
  },
): Promise<Array<T | null>> {
  const { input, targets, rowsToDelete } = params;
  const { adapter, sheetName, key } = input;
  const latestSnapshot = await readRepositorySnapshot(input);

  for (const target of rowsToDelete) {
    const latestSheetRow = findParsedRowByNumberOrNull(
      latestSnapshot.parsedRows,
      target.rowNumber,
    );
    const id = String(target.row[key]);

    if (latestSheetRow === null) {
      throw new ConflictError(`Row "${id}" changed before delete`);
    }

    if (
      Number(latestSheetRow.row["_version"]) !== Number(target.row["_version"])
    ) {
      throw new ConflictError(`Stale delete for key "${id}"`);
    }
  }

  const rowNumbers = rowsToDelete.map((target) => target.rowNumber);

  if (adapter.deleteRows !== undefined) {
    await adapter.deleteRows(sheetName, rowNumbers);
  } else {
    for (const rowNumber of [...rowNumbers].sort((left, right) => right - left)) {
      await adapter.deleteRow(sheetName, rowNumber);
    }
  }

  return targets.map((target) => target?.row ?? null);
}

async function readRepositorySnapshot<T extends Record<string, unknown>>(
  input: RepositoryWriteContext<T>,
): Promise<RepositorySnapshot<T>> {
  const { adapter, sheetName, key, columns } = input;
  const snapshot = await adapter.readSheet(sheetName);

  assertSchema({
    headers: snapshot.headers,
    key,
    columns,
  });

  const parsedRows = parseRepositoryRows<T>({
    headers: snapshot.headers,
    sheetRows: snapshot.rows,
    columns,
  });

  assertUniqueKeys(
    parsedRows.map((parsedRow) => parsedRow.row),
    key,
  );

  return {
    headers: snapshot.headers,
    parsedRows,
  };
}

function createVoidResults(count: number): Array<void> {
  return Array.from({ length: count }, () => undefined);
}

function findParsedRowByNumberOrNull<T extends Record<string, unknown>>(
  parsedRows: Array<ParsedRepositoryRow<T>>,
  rowNumber: number,
): ParsedRepositoryRow<T> | null {
  return parsedRows.find((parsedRow) => parsedRow.rowNumber === rowNumber) ?? null;
}
