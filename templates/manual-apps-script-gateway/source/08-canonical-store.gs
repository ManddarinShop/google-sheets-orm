// Source module for the generated manual Apps Script gateway.

function applyQueueTransaction_(spreadsheet, tasks) {
  const tables = Object.create(null);
  const affectedSheetNames = [];

  tasks.forEach(function(task) {
    if (!tables[task.sheetName]) {
      tables[task.sheetName] = readCanonicalTableForTask_(spreadsheet, task);
      affectedSheetNames.push(task.sheetName);
    } else {
      assertCanonicalTaskMatchesTable_(tables[task.sheetName], task);
    }

    applyTaskToCanonicalTable_(tables[task.sheetName], task);
  });

  affectedSheetNames.sort().forEach(function(sheetName) {
    try {
      writeCanonicalTable_(tables[sheetName]);
    } catch (error) {
      throw markCanonicalWriteStarted_(error);
    }
  });
}

function markCanonicalWriteStarted_(error) {
  const markedError = error && typeof error === "object"
    ? error
    : gatewayError_("internal_error", String(error));

  markedError.canonicalWriteStarted = true;
  return markedError;
}

function readCanonicalTableForTask_(spreadsheet, task) {
  const mapping = getCanonicalSheetMapping_(spreadsheet, task.sheetName);

  if (!mapping) {
    throw gatewayError_(
      "invalid_task",
      "Missing canonical sheet mapping for " + task.sheetName,
    );
  }

  const sheet = getSheet_(spreadsheet, mapping.canonicalSheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    throw gatewayError_(
      "schema_drift",
      "Canonical sheet is empty for " + task.sheetName,
    );
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
  assertCanonicalTaskSchema_(headers, task);
  const keyIndex = headers.indexOf(task.keyHeader);
  const versionIndex = headers.indexOf("_version");

  const rows = values.slice(1).map(function(row) {
    return row.map(toSheetCell_);
  });
  const rowsByKey = Object.create(null);

  rows.forEach(function(row, index) {
    const keyValue = String(row[keyIndex]);

    if (rowsByKey[keyValue] !== undefined) {
      throw gatewayError_("schema_drift", "Duplicate key \"" + keyValue + "\"");
    }

    rowsByKey[keyValue] = index;
  });

  return {
    sheet: sheet,
    headers: headers,
    keyHeader: task.keyHeader,
    keyIndex: keyIndex,
    versionIndex: versionIndex,
    rows: rows,
    rowsByKey: rowsByKey,
  };
}

function assertCanonicalTaskMatchesTable_(table, task) {
  if (table.keyHeader !== task.keyHeader) {
    throw gatewayError_(
      "schema_drift",
      "Queued tasks for " + task.sheetName
        + " must use one key header; expected " + table.keyHeader
        + " but received " + task.keyHeader,
    );
  }

  assertCanonicalTaskSchema_(table.headers, task);
}

function assertCanonicalTaskSchema_(headers, task) {
  const seenHeaders = Object.create(null);

  headers.forEach(function(header) {
    if (header === "") {
      return;
    }

    if (seenHeaders[header]) {
      throw gatewayError_(
        "schema_drift",
        "Duplicate canonical header: " + header,
      );
    }

    seenHeaders[header] = true;
  });

  if (headers.indexOf(task.keyHeader) === -1) {
    throw gatewayError_("schema_drift", "Missing key header: " + task.keyHeader);
  }

  if (headers.indexOf("_version") === -1) {
    throw gatewayError_("schema_drift", "Missing version header: _version");
  }

  // Completed tasks may have their payload redacted. Their durable status and
  // task fingerprint are sufficient for recovery, but there is no payload
  // left from which to infer the modeled field set.
  if (task.status === "done" && isRedactedTaskPayload_(task.payloadJson)) {
    return;
  }

  const payload = requireTaskPayloadObject_(task);
  const rowObject = requirePayloadObject_(
    task.operation === "insert"
      ? payload.row
      : task.operation === "update"
        ? payload.rowToWrite
        : payload.rowToDelete,
    task.operation === "insert"
      ? "payload.row"
      : task.operation === "update"
        ? "payload.rowToWrite"
        : "payload.rowToDelete",
  );

  Object.keys(rowObject).forEach(function(header) {
    if (headers.indexOf(header) === -1) {
      throw gatewayError_(
        "schema_drift",
        "Missing canonical header for queued field: " + header,
      );
    }
  });
}

function applyTaskToCanonicalTable_(table, task) {
  if (task.operation === "insert") {
    applyInsertTask_(table, task);
    return;
  }

  if (task.operation === "update") {
    applyUpdateTask_(table, task);
    return;
  }

  applyDeleteTask_(table, task);
}

function applyInsertTask_(table, task) {
  const row = requireInsertTaskRow_(table, task);

  if (table.rowsByKey[task.keyValue] !== undefined) {
    throw gatewayError_("conflict", "Row \"" + task.keyValue + "\" already exists");
  }

  table.rowsByKey[task.keyValue] = table.rows.length;
  table.rows.push(row);
}

function applyUpdateTask_(table, task) {
  const rowIndex = table.rowsByKey[task.keyValue];

  if (rowIndex === undefined) {
    throw gatewayError_("conflict", "Row \"" + task.keyValue + "\" is missing");
  }

  assertCurrentVersion_(table, rowIndex, task);

  const payload = requireTaskPayloadObject_(task);
  const rowToWrite = requirePayloadObject_(
    payload.rowToWrite,
    "payload.rowToWrite",
  );
  const versionToWrite = requireTaskFiniteNumber_(
    rowToWrite._version,
    "payload.rowToWrite._version",
  );

  if (versionToWrite <= task.expectedVersion) {
    throw gatewayError_(
      "invalid_task",
      "payload.rowToWrite._version must advance expectedVersion",
    );
  }

  table.rows[rowIndex] = rowObjectToCanonicalCells_(
    table,
    rowToWrite,
    table.rows[rowIndex],
  );
  assertTaskRowMatchesKey_(table, table.rows[rowIndex], task);
}

function applyDeleteTask_(table, task) {
  const rowIndex = table.rowsByKey[task.keyValue];

  if (rowIndex === undefined) {
    throw gatewayError_("conflict", "Row \"" + task.keyValue + "\" is missing");
  }

  assertCurrentVersion_(table, rowIndex, task);
  assertDeletePayloadMatchesTask_(task);

  table.rows.splice(rowIndex, 1);
  table.rowsByKey = Object.create(null);
  table.rows.forEach(function(row, index) {
    table.rowsByKey[String(row[table.keyIndex])] = index;
  });
}

function assertDeletePayloadMatchesTask_(task) {
  const payload = requireTaskPayloadObject_(task);
  const rowToDelete = requirePayloadObject_(
    payload.rowToDelete,
    "payload.rowToDelete",
  );
  const versionToDelete = requireTaskFiniteNumber_(
    rowToDelete._version,
    "payload.rowToDelete._version",
  );

  if (String(rowToDelete[task.keyHeader]) !== task.keyValue) {
    throw gatewayError_(
      "invalid_task",
      "payload.rowToDelete key must match queued key",
    );
  }

  if (versionToDelete !== task.expectedVersion) {
    throw gatewayError_(
      "invalid_task",
      "payload.rowToDelete._version must match expectedVersion",
    );
  }

  return rowToDelete;
}

function assertCurrentVersion_(table, rowIndex, task) {
  const currentVersion = Number(table.rows[rowIndex][table.versionIndex]);

  if (currentVersion !== task.expectedVersion) {
    throw gatewayError_(
      "conflict",
      "Stale task for key \"" + task.keyValue + "\"",
    );
  }
}

function assertTaskRowMatchesKey_(table, row, task) {
  if (String(row[table.keyIndex]) !== task.keyValue) {
    throw gatewayError_(
      "invalid_task",
      "Task payload key does not match queued key for " + task.taskId,
    );
  }
}

/**
 * Validates an insert's immutable identity before materializing its cells.
 * Invalid key or version data must fail before the canonical table is mutated.
 */
function requireInsertTaskRow_(table, task) {
  const payload = requireTaskPayloadObject_(task);
  const rowObject = requirePayloadObject_(payload.row, "payload.row");

  if (!Object.prototype.hasOwnProperty.call(rowObject, task.keyHeader)) {
    throw gatewayError_(
      "invalid_task",
      "payload.row must include the queued key header: " + task.keyHeader,
    );
  }

  if (
    rowObject[task.keyHeader] === null
    || rowObject[task.keyHeader] === undefined
    || String(rowObject[task.keyHeader]) !== task.keyValue
  ) {
    throw gatewayError_(
      "invalid_task",
      "payload.row key must match queued key",
    );
  }

  requireTaskFiniteNumber_(rowObject._version, "payload.row._version");

  const row = rowObjectToCanonicalCells_(table, rowObject, null);
  assertTaskRowMatchesKey_(table, row, task);
  return row;
}

function requireTaskPayloadObject_(task) {
  try {
    return requirePayloadObject_(
      JSON.parse(task.payloadJson),
      "payloadJson",
    );
  } catch (error) {
    if (error && error.code) {
      throw error;
    }

    throw gatewayError_("invalid_task", "Invalid payloadJson for " + task.taskId);
  }
}

function requirePayloadObject_(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError_("invalid_task", name + " must be an object");
  }

  return value;
}

function requireTaskFiniteNumber_(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw gatewayError_("invalid_task", name + " must be a number");
  }

  return value;
}

function rowObjectToCanonicalCells_(table, rowObject, existingRow) {
  return table.headers.map(function(header, index) {
    if (Object.prototype.hasOwnProperty.call(rowObject, header)) {
      return toSheetCell_(rowObject[header]);
    }

    return existingRow ? existingRow[index] : null;
  });
}

function writeCanonicalTable_(table) {
  table.sheet
    .getRange(1, 1, 1, table.headers.length)
    .setValues([table.headers]);

  if (table.rows.length > 0) {
    table.sheet
      .getRange(2, 1, table.rows.length, table.headers.length)
      .setValues(table.rows);
  }

  clearTrailingCanonicalRows_(table.sheet, table.rows.length + 2);
  clearTrailingCanonicalColumns_(table.sheet, table.headers.length + 1);
}

function clearTrailingCanonicalRows_(sheet, firstTrailingRow) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow >= firstTrailingRow && lastColumn > 0) {
    sheet
      .getRange(firstTrailingRow, 1, lastRow - firstTrailingRow + 1, lastColumn)
      .clearContent();
  }
}

function clearTrailingCanonicalColumns_(sheet, firstTrailingColumn) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastColumn >= firstTrailingColumn && lastRow > 0) {
    sheet
      .getRange(1, firstTrailingColumn, lastRow, lastColumn - firstTrailingColumn + 1)
      .clearContent();
  }
}
