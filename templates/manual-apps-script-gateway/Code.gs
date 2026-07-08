// typed-sheets - Manual Apps Script Gateway
//
// This file is the canonical Apps Script gateway template shipped with the npm
// package. The setup CLI points users to this file instead of embedding a copy.

const TYPED_SHEETS_CONFIG_PROPERTY = "typedSheetsConfig";
const TYPED_SHEETS_META_SHEET_NAME = "_typed_sheets_meta";
const TYPED_SHEETS_GATEWAY_URL = "";
const TYPED_SHEETS_INTERNAL_PREFIX = "_typed_sheets_";
const TYPED_SHEETS_DATA_SHEET_PREFIX = "_typed_sheets_data_";
const TYPED_SHEETS_META_MAPPING_KEY_PREFIX = "sheetMapping:";
const TYPED_SHEETS_MAX_SHEET_NAME_LENGTH = 100;
const TYPED_SHEETS_TASK_QUEUE_SHEET_NAME = "_typed_sheets_task_queue";
const TYPED_SHEETS_TASK_QUEUE_HEADERS = [
  "taskId",
  "transactionId",
  "transactionIndex",
  "sequence",
  "status",
  "operation",
  "sheetName",
  "keyHeader",
  "keyValue",
  "expectedVersion",
  "payloadJson",
  "attempts",
  "lastErrorCode",
  "lastErrorMessage",
  "createdAt",
  "updatedAt",
];

/**
 * Generates and stores the gateway config for this spreadsheet.
 *
 * @returns {object} The typed-sheets config to paste into .typed-sheets.json.
 */
function setupTypedSheets() {
  const config = createTypedSheetsConfig_();
  const configJson = JSON.stringify(config, null, 2);

  Logger.log(configJson);

  return config;
}

/**
 * Handles typed-sheets gateway HTTP requests under the document lock.
 *
 * @param {object} e - Apps Script Web App event with the JSON request body.
 * @returns {TextOutput} JSON response for the requested gateway operation.
 */
function doPost(e) {
  try {
    const request = parseRequest_(e);
    const config = getTypedSheetsConfig_();

    if (!config || request.secret !== config.auth.gatewaySecret) {
      return error_("unauthorized", "Invalid gateway secret");
    }

    const operation = validateOperation_(request);
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
      const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

      if (operation === "ping") {
        return json_({
          ok: true,
          locked: true,
          spreadsheetId: spreadsheet.getId(),
          sheetName: spreadsheet.getActiveSheet().getName(),
        });
      }

      if (operation === "ensureSheet") {
        ensureSheet_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "initializeSheet") {
        initializeSheet_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "initializeSystemSheets") {
        return json_({
          ok: true,
          systemSheets: initializeSystemSheets_(spreadsheet, request),
        });
      }

      if (operation === "writeHeader") {
        writeHeader_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "readSheet") {
        return json_(readSheet_(spreadsheet, request));
      }

      if (operation === "appendRow") {
        appendRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "appendRows") {
        appendRows_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "updateRow") {
        updateRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "updateRowsByKey") {
        return json_(updateRowsByKey_(spreadsheet, request));
      }

      if (operation === "deleteRow") {
        deleteRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRows") {
        deleteRows_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRowsByKey") {
        return json_(deleteRowsByKey_(spreadsheet, request));
      }

      return error_("unknown_operation", "Unknown operation: " + operation);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return error_(
      error && error.code ? error.code : "internal_error",
      error && error.message ? error.message : String(error),
    );
  }
}

function parseRequest_(e) {
  try {
    const request = JSON.parse((e.postData && e.postData.contents) || "{}");

    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw gatewayError_("invalid_request", "Request body must be an object");
    }

    return request;
  } catch (error) {
    if (error && error.code) {
      throw error;
    }

    throw gatewayError_("invalid_json", "Request body must be valid JSON");
  }
}

function validateOperation_(request) {
  const operation = requireString_(request.operation, "operation");
  const operations = [
    "ping",
    "ensureSheet",
    "initializeSheet",
    "initializeSystemSheets",
    "writeHeader",
    "readSheet",
    "appendRow",
    "appendRows",
    "updateRow",
    "updateRowsByKey",
    "deleteRow",
    "deleteRows",
    "deleteRowsByKey",
  ];

  if (operations.indexOf(operation) === -1) {
    throw gatewayError_("unknown_operation", "Unknown operation: " + operation);
  }

  if (operation === "ping") {
    return operation;
  }

  requireString_(request.sheetName, "sheetName");

  if (operation === "initializeSheet" || operation === "writeHeader") {
    requireStringArray_(request.headers, "headers");
  }

  if (operation === "initializeSystemSheets") {
    requireStringArray_(request.headers, "headers");
  }

  if (operation === "appendRow") {
    requireSheetCellArray_(request.row, "row");
  }

  if (operation === "appendRows") {
    requireSheetCellRows_(request.rows, "rows");
  }

  if (operation === "updateRow") {
    requirePositiveInteger_(request.rowNumber, "rowNumber");
    requireSheetCellArray_(request.row, "row");
  }

  if (operation === "updateRowsByKey") {
    requireStringArray_(request.expectedHeaders, "expectedHeaders");
    requireString_(request.keyHeader, "keyHeader");
    requireString_(request.versionHeader, "versionHeader");
    requireUpdateRows_(request.updates, "updates");
  }

  if (operation === "deleteRow") {
    requirePositiveInteger_(request.rowNumber, "rowNumber");
  }

  if (operation === "deleteRows") {
    requirePositiveIntegerArray_(request.rowNumbers, "rowNumbers");
  }

  if (operation === "deleteRowsByKey") {
    requireStringArray_(request.expectedHeaders, "expectedHeaders");
    requireString_(request.keyHeader, "keyHeader");
    requireString_(request.versionHeader, "versionHeader");
    requireStringArray_(request.ids, "ids");
    requireNumberRecord_(request.versionsById, "versionsById");
  }

  return operation;
}

function ensureSheet_(spreadsheet, request) {
  const sheetName = requireString_(request.sheetName, "sheetName");
  const existing = spreadsheet.getSheetByName(sheetName);

  if (existing) {
    return;
  }

  spreadsheet.insertSheet(sheetName);
}

function initializeSheet_(spreadsheet, request) {
  const sheetName = requireString_(request.sheetName, "sheetName");
  const headers = requireStringArray_(request.headers, "headers");
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * Creates hidden/protected system sheets for a logical repository table.
 *
 * The canonical sheet stores trusted row state while the visible sheet remains
 * a projection. Protection is best-effort because Apps Script can deny it for
 * some spreadsheet or account configurations, and Sheet owners can still edit
 * protected sheets. Creation still succeeds and logs that protection could not
 * be applied.
 */
function initializeSystemSheets_(spreadsheet, request) {
  const logicalSheetName = requireProjectionSheetName_(
    request.sheetName,
    "sheetName",
  );
  const headers = requireStringArray_(request.headers, "headers");
  const canonicalSheetName = getOrCreateCanonicalSheetName_(
    spreadsheet,
    logicalSheetName,
  );

  ensureProjectionSheet_(spreadsheet, logicalSheetName, headers);
  ensureInternalSheet_(spreadsheet, canonicalSheetName, headers);
  ensureInternalSheet_(
    spreadsheet,
    TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    TYPED_SHEETS_TASK_QUEUE_HEADERS,
  );

  return {
    logicalSheetName: logicalSheetName,
    canonicalSheetName: canonicalSheetName,
    projectionSheetName: logicalSheetName,
    taskQueueSheetName: TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
  };
}

function getOrCreateCanonicalSheetName_(spreadsheet, logicalSheetName) {
  const existingMapping = getCanonicalSheetMapping_(
    spreadsheet,
    logicalSheetName,
  );

  if (existingMapping) {
    return existingMapping.canonicalSheetName;
  }

  const hash = createShortHash_(logicalSheetName);
  let collisionIndex = 0;

  while (collisionIndex < 100) {
    const canonicalSheetName = createCanonicalSheetName_(
      logicalSheetName,
      hash,
      collisionIndex,
    );

    if (!spreadsheet.getSheetByName(canonicalSheetName)) {
      persistCanonicalSheetMapping_(spreadsheet, {
        logicalSheetName: logicalSheetName,
        canonicalSheetName: canonicalSheetName,
        projectionSheetName: logicalSheetName,
      });

      return canonicalSheetName;
    }

    collisionIndex += 1;
  }

  throw gatewayError_(
    "system_sheet_name_collision",
    "Could not allocate a canonical sheet name for " + logicalSheetName,
  );
}

function createCanonicalSheetName_(logicalSheetName, hash, collisionIndex) {
  const suffix = "_" + hash + (collisionIndex === 0 ? "" : "_" + collisionIndex);
  const maxSlugLength =
    TYPED_SHEETS_MAX_SHEET_NAME_LENGTH
    - TYPED_SHEETS_DATA_SHEET_PREFIX.length
    - suffix.length;
  const slug = createSheetNameSlug_(logicalSheetName).slice(
    0,
    Math.max(1, maxSlugLength),
  );

  return TYPED_SHEETS_DATA_SHEET_PREFIX + slug + suffix;
}

function createSheetNameSlug_(value) {
  const slug = value
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || "sheet";
}

function createShortHash_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
  );
  let hex = "";

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const unsignedByte = byte < 0 ? byte + 256 : byte;
    hex += ("0" + unsignedByte.toString(16)).slice(-2);
  }

  return hex.slice(0, 12);
}

function getCanonicalSheetMapping_(spreadsheet, logicalSheetName) {
  const sheet = spreadsheet.getSheetByName(TYPED_SHEETS_META_SHEET_NAME);

  if (!sheet) {
    return null;
  }

  const rows = readMetaRows_(sheet);
  const key = TYPED_SHEETS_META_MAPPING_KEY_PREFIX + logicalSheetName;

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] !== key) {
      continue;
    }

    try {
      const mapping = JSON.parse(String(rows[index][1]));

      if (
        mapping
        && mapping.logicalSheetName === logicalSheetName
        && typeof mapping.canonicalSheetName === "string"
        && mapping.canonicalSheetName.trim() !== ""
      ) {
        return mapping;
      }
    } catch (error) {
      throw gatewayError_(
        "invalid_meta",
        "Invalid canonical sheet mapping for " + logicalSheetName,
      );
    }
  }

  return null;
}

function persistCanonicalSheetMapping_(spreadsheet, mapping) {
  const sheet = ensureMetaSheetStructure_(spreadsheet);
  const rows = readMetaRows_(sheet);
  const key = TYPED_SHEETS_META_MAPPING_KEY_PREFIX + mapping.logicalSheetName;
  const value = JSON.stringify(mapping);

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] === key) {
      sheet.getRange(index + 2, 2, 1, 1).setValues([[value]]);
      return;
    }
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 2).setValues([[key, value]]);
}

function readMetaRows_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, 2).getValues().map(function(row) {
    return [String(row[0] || ""), String(row[1] || "")];
  });
}

function requireProjectionSheetName_(value, name) {
  const sheetName = requireString_(value, name);

  if (sheetName.indexOf(TYPED_SHEETS_INTERNAL_PREFIX) === 0) {
    throw gatewayError_(
      "invalid_request",
      name + " must not start with " + TYPED_SHEETS_INTERNAL_PREFIX,
    );
  }

  return sheetName;
}

function ensureProjectionSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function ensureInternalSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  hideInternalSheet_(sheet);
  protectInternalSheet_(sheet, sheetName);
}

function hideInternalSheet_(sheet) {
  sheet.hideSheet();
}

function protectInternalSheet_(sheet, sheetName) {
  try {
    const protection = sheet.protect();
    protection.setDescription("typed-sheets internal sheet: " + sheetName);

    if (typeof protection.setWarningOnly === "function") {
      protection.setWarningOnly(false);
    }

    if (
      typeof protection.getEditors === "function"
      && typeof protection.removeEditors === "function"
    ) {
      protection.removeEditors(protection.getEditors());
    }

    if (
      typeof protection.canDomainEdit === "function"
      && protection.canDomainEdit()
      && typeof protection.setDomainEdit === "function"
    ) {
      protection.setDomainEdit(false);
    }
  } catch (error) {
    Logger.log(
      "typed-sheets could not protect internal sheet "
        + sheetName
        + ": "
        + (error && error.message ? error.message : String(error)),
    );
  }
}

function writeHeader_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const headers = requireStringArray_(request.headers, "headers");

  writeHeaderIfEmpty_(sheet, headers);
}

function writeHeaderIfEmpty_(sheet, headers) {
  if (!isHeaderRowEmpty_(sheet)) {
    throw gatewayError_(
      "header_not_empty",
      "Header row is not empty; refusing to overwrite existing data",
    );
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

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

function getSheet_(spreadsheet, sheetName) {
  const name = requireString_(sheetName, "sheetName");
  const sheet = spreadsheet.getSheetByName(name);

  if (!sheet) {
    throw gatewayError_("sheet_not_found", "Sheet not found: " + name);
  }

  return sheet;
}

function requireString_(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw gatewayError_("invalid_request", name + " must be a non-empty string");
  }

  return value;
}

function requireStringArray_(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw gatewayError_(
      "invalid_request",
      name + " must be a non-empty string array",
    );
  }

  value.forEach(function(item, index) {
    if (typeof item !== "string" || item.trim() === "") {
      throw gatewayError_(
        "invalid_request",
        name + "[" + index + "] must be a non-empty string",
      );
    }
  });

  return value;
}

function requireSheetCellArray_(value, name) {
  if (!Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an array");
  }

  value.forEach(function(item, index) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw gatewayError_(
        "invalid_request",
        name + "[" + index + "] must be a string, number, boolean, or null",
      );
    }
  });

  return value;
}

function requireSheetCellRows_(value, name) {
  if (!Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an array");
  }

  value.forEach(function(row, index) {
    requireSheetCellArray_(row, name + "[" + index + "]");
  });

  return value;
}

function requireUpdateRows_(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw gatewayError_("invalid_request", name + " must be a non-empty array");
  }

  value.forEach(function(update, index) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw gatewayError_(
        "invalid_request",
        name + "[" + index + "] must be an object",
      );
    }

    requireString_(update.id, name + "[" + index + "].id");
    requireFiniteNumber_(
      update.expectedVersion,
      name + "[" + index + "].expectedVersion",
    );
    requireSheetCellArray_(update.row, name + "[" + index + "].row");
  });

  return value;
}

function requirePositiveInteger_(value, name) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw gatewayError_("invalid_request", name + " must be a positive integer");
  }

  return numberValue;
}

function requirePositiveIntegerArray_(value, name) {
  if (!Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an array");
  }

  value.forEach(function(item, index) {
    requirePositiveInteger_(item, name + "[" + index + "]");
  });

  return value.map(function(item) {
    return Number(item);
  });
}

function requireFiniteNumber_(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw gatewayError_("invalid_request", name + " must be a number");
  }

  return value;
}

function requireNumberRecord_(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an object");
  }

  Object.keys(value).forEach(function(key) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw gatewayError_("invalid_request", name + "." + key + " must be a number");
    }
  });

  return value;
}

function assertExpectedHeaders_(actualHeaders, expectedHeaders, operation) {
  if (actualHeaders.length < expectedHeaders.length) {
    throw gatewayError_(
      "schema_drift",
      "Header row changed before " + operation,
    );
  }

  expectedHeaders.forEach(function(expectedHeader, index) {
    if (actualHeaders[index] !== expectedHeader) {
      throw gatewayError_(
        "schema_drift",
        "Header row changed before " + operation,
      );
    }
  });
}

function isHeaderRowEmpty_(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    return true;
  }

  const headerValues = sheet.getRange(1, 1, 1, lastColumn).getValues()[0] || [];

  return isEmptyRow_(headerValues);
}

function isEmptyRow_(row) {
  return row.every(function(value) {
    return value === "" || value === null;
  });
}

function toSheetCell_(value) {
  if (value === "") {
    return null;
  }

  return value;
}

function gatewayError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function error_(code, message) {
  return json_({
    ok: false,
    code: code,
    error: code,
    message: message,
  });
}

function createTypedSheetsConfig_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = spreadsheet.getActiveSheet();
  const lock = LockService.getDocumentLock();

  lock.waitLock(30000);

  try {
    const existing = getTypedSheetsConfig_();
    const gatewayUrl = getGatewayUrl_(existing);
    const gatewaySecret = existing && existing.auth.gatewaySecret
      ? existing.auth.gatewaySecret
      : Utilities.getUuid();

    const config = {
      spreadsheetUrl: spreadsheet.getUrl(),
      defaultSheetName: activeSheet.getName(),
      auth: {
        type: "apps-script-gateway",
        gatewayUrl: gatewayUrl,
        gatewaySecret: gatewaySecret,
      },
    };

    PropertiesService.getDocumentProperties().setProperty(
      TYPED_SHEETS_CONFIG_PROPERTY,
      JSON.stringify(config),
    );

    ensureMetaSheet_(spreadsheet, config);

    return config;
  } finally {
    lock.releaseLock();
  }
}

function getTypedSheetsConfig_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(
    TYPED_SHEETS_CONFIG_PROPERTY,
  );

  return raw ? JSON.parse(raw) : null;
}

function ensureMetaSheet_(spreadsheet, config) {
  const sheet = ensureMetaSheetStructure_(spreadsheet);
  const preservedRows = readMetaRows_(sheet).filter(function(row) {
    return row[0].indexOf(TYPED_SHEETS_META_MAPPING_KEY_PREFIX) === 0;
  });
  const rows = [
    ["spreadsheetUrl", config.spreadsheetUrl],
    ["defaultSheetName", config.defaultSheetName],
    ["gatewayUrl", config.auth.gatewayUrl],
    ["authType", config.auth.type],
    ["connectedAt", new Date().toISOString()],
  ].concat(preservedRows);

  sheet.clear();
  sheet.hideSheet();
  sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function ensureMetaSheetStructure_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(TYPED_SHEETS_META_SHEET_NAME)
    || spreadsheet.insertSheet(TYPED_SHEETS_META_SHEET_NAME);

  sheet.hideSheet();

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  }

  return sheet;
}

function getGatewayUrl_(existingConfig) {
  if (TYPED_SHEETS_GATEWAY_URL.trim() !== "") {
    return requireGatewayUrl_(TYPED_SHEETS_GATEWAY_URL.trim());
  }

  if (
    existingConfig
    && existingConfig.auth
    && typeof existingConfig.auth.gatewayUrl === "string"
    && existingConfig.auth.gatewayUrl.trim() !== ""
  ) {
    return requireGatewayUrl_(existingConfig.auth.gatewayUrl.trim());
  }

  throw gatewayError_(
    "missing_gateway_url",
    "Set TYPED_SHEETS_GATEWAY_URL to the deployed Web App URL that ends with /exec before running setupTypedSheets()",
  );
}

function requireGatewayUrl_(gatewayUrl) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gatewayUrl)) {
    throw gatewayError_(
      "invalid_gateway_url",
      "TYPED_SHEETS_GATEWAY_URL must be a deployed Apps Script Web App URL that ends with /exec",
    );
  }

  return gatewayUrl;
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
