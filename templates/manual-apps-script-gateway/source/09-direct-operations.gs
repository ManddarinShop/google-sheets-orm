// Source module for the generated manual Apps Script gateway.

function readSheet_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    return {
      ok: true,
      headers: [],
      rows: [],
    };
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headerValues = values[0] || [];
  const headers = headerValues.map(function(value) {
    return String(value);
  });

  if (isEmptyRow_(headerValues)) {
    return {
      ok: true,
      headers: [],
      rows: [],
    };
  }

  const rows = values.slice(1).map(function(cells, index) {
    return {
      rowNumber: index + 2,
      cells: cells.map(toSheetCell_),
    };
  });

  return {
    ok: true,
    headers: headers,
    rows: rows,
  };
}

/** Reads canonical rows by logical repository name for queued repositories. */
function readCanonicalSheet_(spreadsheet, request) {
  const logicalSheetName = requireProjectionSheetName_(
    request.sheetName,
    "sheetName",
  );
  const mapping = getCanonicalSheetMapping_(spreadsheet, logicalSheetName);

  if (!mapping) {
    throw gatewayError_(
      "schema_drift",
      "Missing canonical sheet mapping for " + logicalSheetName,
    );
  }

  return readSheet_(spreadsheet, {
    sheetName: mapping.canonicalSheetName,
  });
}

// Legacy direct-write gateway helpers. They are kept only for existing
// createRepositoryFromConfig() Apps Script users until queued repository writes
// replace this path.
function writeHeader_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const headers = requireStringArray_(request.headers, "headers");

  writeHeaderIfEmpty_(sheet, headers);
}

function appendRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const row = requireSheetCellArray_(request.row, "row");

  sheet.appendRow(row);
}

// Appends multiple rows with one range write to reduce gateway round trips.
function appendRows_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const rows = requireSheetCellRows_(request.rows, "rows");

  if (rows.length === 0) {
    return;
  }

  const width = rows[0].length;

  rows.forEach(function(row, index) {
    if (row.length !== width) {
      throw gatewayError_(
        "invalid_request",
        "rows[" + index + "] must have the same length as rows[0]",
      );
    }
  });

  sheet
    .getRange(sheet.getLastRow() + 1, 1, rows.length, width)
    .setValues(rows);
}

function updateRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const row = requireSheetCellArray_(request.row, "row");
  const rowNumber = requirePositiveInteger_(request.rowNumber, "rowNumber");

  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
}

// Updates rows by key after validating expected headers and _version under one lock.
function updateRowsByKey_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const expectedHeaders = requireStringArray_(
    request.expectedHeaders,
    "expectedHeaders",
  );
  const keyHeader = requireString_(request.keyHeader, "keyHeader");
  const versionHeader = requireString_(request.versionHeader, "versionHeader");
  const updates = requireUpdateRows_(request.updates, "updates");
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    throw gatewayError_("schema_drift", "Sheet is empty before update");
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
  const keyIndex = headers.indexOf(keyHeader);
  const versionIndex = headers.indexOf(versionHeader);

  assertExpectedHeaders_(headers, expectedHeaders, "update");

  if (keyIndex === -1) {
    throw gatewayError_("schema_drift", "Missing key header: " + keyHeader);
  }

  if (versionIndex === -1) {
    throw gatewayError_(
      "schema_drift",
      "Missing version header: " + versionHeader,
    );
  }

  const updatesById = Object.create(null);
  const seenRequestedIds = Object.create(null);
  const rowsToUpdate = [];

  updates.forEach(function(update) {
    if (updatesById[update.id]) {
      throw gatewayError_(
        "invalid_request",
        "updates must not contain duplicate ids",
      );
    }

    if (update.row.length !== expectedHeaders.length) {
      throw gatewayError_(
        "invalid_request",
        "updates." + update.id + ".row must match expectedHeaders length",
      );
    }

    updatesById[update.id] = update;
  });

  values.slice(1).forEach(function(cells, index) {
    const id = String(cells[keyIndex]);

    if (!updatesById[id] && !seenRequestedIds[id]) {
      return;
    }

    if (seenRequestedIds[id]) {
      throw gatewayError_("schema_drift", "Duplicate key \"" + id + "\"");
    }

    seenRequestedIds[id] = true;

    const update = updatesById[id];
    const version = Number(cells[versionIndex]);

    if (version !== update.expectedVersion) {
      throw gatewayError_("conflict", "Stale write for key \"" + id + "\"");
    }

    rowsToUpdate.push({
      id: id,
      rowNumber: index + 2,
      row: update.row,
    });

    delete updatesById[id];
  });

  Object.keys(updatesById).forEach(function(id) {
    throw gatewayError_("conflict", "Row \"" + id + "\" changed before update");
  });

  rowsToUpdate.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, update.row.length).setValues([
      update.row,
    ]);
  });

  return {
    ok: true,
    updatedRows: rowsToUpdate.map(function(update) {
      return {
        id: update.id,
        cells: update.row.map(toSheetCell_),
      };
    }),
  };
}

// Deletes only data rows; row 1 is reserved for the schema header.
function deleteRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const rowNumber = requirePositiveInteger_(request.rowNumber, "rowNumber");

  if (rowNumber < 2) {
    throw gatewayError_("invalid_request", "rowNumber must target a data row");
  }

  sheet.deleteRow(rowNumber);
}

// Deletes multiple data rows from bottom to top so row shifts are safe.
function deleteRows_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const rowNumbers = requirePositiveIntegerArray_(
    request.rowNumbers,
    "rowNumbers",
  );
  const seen = {};

  rowNumbers.forEach(function(rowNumber) {
    if (rowNumber < 2) {
      throw gatewayError_("invalid_request", "rowNumbers must target data rows");
    }

    if (seen[rowNumber]) {
      throw gatewayError_(
        "invalid_request",
        "rowNumbers must not contain duplicates",
      );
    }

    seen[rowNumber] = true;
  });

  rowNumbers
    .slice()
    .sort(function(left, right) {
      return right - left;
    })
    .forEach(function(rowNumber) {
      sheet.deleteRow(rowNumber);
    });
}

// Deletes rows by key after validating the expected _version under one lock.
function deleteRowsByKey_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const expectedHeaders = requireStringArray_(
    request.expectedHeaders,
    "expectedHeaders",
  );
  const keyHeader = requireString_(request.keyHeader, "keyHeader");
  const versionHeader = requireString_(request.versionHeader, "versionHeader");
  const ids = requireStringArray_(request.ids, "ids");
  const versionsById = requireNumberRecord_(request.versionsById, "versionsById");
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    throw gatewayError_("schema_drift", "Sheet is empty before delete");
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
  const keyIndex = headers.indexOf(keyHeader);
  const versionIndex = headers.indexOf(versionHeader);

  assertExpectedHeaders_(headers, expectedHeaders, "delete");

  if (keyIndex === -1) {
    throw gatewayError_("schema_drift", "Missing key header: " + keyHeader);
  }

  if (versionIndex === -1) {
    throw gatewayError_(
      "schema_drift",
      "Missing version header: " + versionHeader,
    );
  }

  const requestedIds = Object.create(null);
  const seenRequestedIds = Object.create(null);
  const rowsToDelete = [];

  ids.forEach(function(id) {
    if (requestedIds[id]) {
      throw gatewayError_("invalid_request", "ids must not contain duplicates");
    }

    requestedIds[id] = true;
  });

  values.slice(1).forEach(function(cells, index) {
    const id = String(cells[keyIndex]);

    if (!requestedIds[id] && !seenRequestedIds[id]) {
      return;
    }

    if (seenRequestedIds[id]) {
      throw gatewayError_("schema_drift", "Duplicate key \"" + id + "\"");
    }

    seenRequestedIds[id] = true;

    const version = Number(cells[versionIndex]);

    if (version !== versionsById[id]) {
      throw gatewayError_("conflict", "Stale delete for key \"" + id + "\"");
    }

    rowsToDelete.push({
      id: id,
      rowNumber: index + 2,
      cells: cells.map(toSheetCell_),
    });

    delete requestedIds[id];
  });

  Object.keys(requestedIds).forEach(function(id) {
    throw gatewayError_("conflict", "Row \"" + id + "\" changed before delete");
  });

  rowsToDelete
    .slice()
    .sort(function(left, right) {
      return right.rowNumber - left.rowNumber;
    })
    .forEach(function(row) {
      sheet.deleteRow(row.rowNumber);
    });

  return {
    ok: true,
    deletedRows: rowsToDelete.map(function(row) {
      return {
        id: row.id,
        cells: row.cells,
      };
    }),
  };
}
