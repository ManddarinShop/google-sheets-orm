// Source module for the generated manual Apps Script gateway.

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
  assertExpectedHeaders_(headers, headers, "projection initialization");
  const canonicalSheetName = getOrCreateCanonicalSheetName_(
    spreadsheet,
    logicalSheetName,
  );

  ensureProjectionSheet_(spreadsheet, logicalSheetName, headers);
  ensureInternalSheet_(spreadsheet, canonicalSheetName, headers);
  migrateProjectionToCanonicalIfNeeded_(
    spreadsheet,
    logicalSheetName,
    canonicalSheetName,
    headers,
  );
  ensureTaskQueueSheet_(spreadsheet);

  return {
    logicalSheetName: logicalSheetName,
    canonicalSheetName: canonicalSheetName,
    projectionSheetName: logicalSheetName,
    taskQueueSheetName: TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
  };
}

/**
 * Seeds an empty canonical sheet from an existing direct-write projection.
 * This one-time copy preserves legacy rows before queued processing takes
 * ownership of the canonical state.
 */
function migrateProjectionToCanonicalIfNeeded_(
  spreadsheet,
  logicalSheetName,
  canonicalSheetName,
  headers,
) {
  const projectionSheet = getSheet_(spreadsheet, logicalSheetName);
  const canonicalSheet = getSheet_(spreadsheet, canonicalSheetName);

  if (isProjectionMigrationCompleted_(
    spreadsheet,
    logicalSheetName,
    canonicalSheetName,
  )) {
    return;
  }

  if (canonicalSheet.getLastRow() > 1) {
    markProjectionMigrationCompleted_(
      spreadsheet,
      logicalSheetName,
      canonicalSheetName,
    );
    return;
  }

  const projectionLastRow = projectionSheet.getLastRow();

  if (projectionLastRow <= 1) {
    markProjectionMigrationCompleted_(
      spreadsheet,
      logicalSheetName,
      canonicalSheetName,
    );
    return;
  }

  const projectionLastColumn = projectionSheet.getLastColumn();
  const projectionHeaders = projectionSheet
    .getRange(1, 1, 1, projectionLastColumn)
    .getValues()[0]
    .map(function(value) {
      return String(value);
    });

  assertExpectedHeaders_(projectionHeaders, headers, "canonical migration");

  const rows = projectionSheet
    .getRange(2, 1, projectionLastRow - 1, headers.length)
    .getValues()
    .map(function(row) {
      return row.map(toSheetCell_);
    });

  canonicalSheet
    .getRange(2, 1, rows.length, headers.length)
    .setValues(rows);

  markProjectionMigrationCompleted_(
    spreadsheet,
    logicalSheetName,
    canonicalSheetName,
  );
}

/**
 * Appends one transaction worth of write tasks to the durable internal queue.
 *
 * The caller supplies stable task ids and transaction ids. The gateway assigns
 * monotonic sequence values under the document lock so processors can replay
 * write intent in enqueue order.
 */

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
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
  )).slice(0, 12);
}

/**
 * Creates a stable fingerprint for one enqueue request. Mutable queue state is
 * intentionally excluded so the fingerprint survives processing and retries.
 */

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

function isProjectionMigrationCompleted_(
  spreadsheet,
  logicalSheetName,
  canonicalSheetName,
) {
  const sheet = spreadsheet.getSheetByName(TYPED_SHEETS_META_SHEET_NAME);

  if (!sheet) {
    return false;
  }

  const key = TYPED_SHEETS_META_MIGRATION_KEY_PREFIX + logicalSheetName;
  const rows = readMetaRows_(sheet);

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] !== key) {
      continue;
    }

    try {
      const migration = JSON.parse(String(rows[index][1]));

      return migration
        && migration.status === "completed"
        && migration.canonicalSheetName === canonicalSheetName;
    } catch (error) {
      throw gatewayError_(
        "invalid_meta",
        "Invalid projection migration metadata for " + logicalSheetName,
      );
    }
  }

  return false;
}

function markProjectionMigrationCompleted_(
  spreadsheet,
  logicalSheetName,
  canonicalSheetName,
) {
  const sheet = ensureMetaSheetStructure_(spreadsheet);
  const rows = readMetaRows_(sheet);
  const key = TYPED_SHEETS_META_MIGRATION_KEY_PREFIX + logicalSheetName;
  const value = JSON.stringify({
    logicalSheetName: logicalSheetName,
    canonicalSheetName: canonicalSheetName,
    status: "completed",
  });

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
  // Validate the requested schema even when the sheet is being created. This
  // catches duplicate headers before they become a new, invalid system sheet.
  assertExpectedHeaders_(headers, headers, "projection initialization");

  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    assertExpectedHeaders_(
      readHeaderRow_(sheet),
      headers,
      "projection initialization",
    );
  }
}

function ensureInternalSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    assertExpectedHeaders_(
      readHeaderRow_(sheet),
      headers,
      "canonical initialization",
    );
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

function writeHeaderIfEmpty_(sheet, headers) {
  if (!isHeaderRowEmpty_(sheet)) {
    throw gatewayError_(
      "header_not_empty",
      "Header row is not empty; refusing to overwrite existing data",
    );
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
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
    return row[0].indexOf(TYPED_SHEETS_META_MAPPING_KEY_PREFIX) === 0
      || row[0].indexOf(TYPED_SHEETS_META_MIGRATION_KEY_PREFIX) === 0;
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
