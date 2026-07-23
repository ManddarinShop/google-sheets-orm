/**
 * Registry-bound Apps Script gateway for the SQLite-authoritative sync runtime.
 *
 * The gateway only executes signed, range-constrained reads and conditional
 * projection effects. SQLite remains the canonical decision maker.
 */

// Legacy keys are read only as a one-time migration path, so redeployment does
// not rotate an existing gateway secret.
var GATEWAY_SHEET_ID_PROPERTY_ = "TYPED_SHEETS_GATEWAY_SHEET_ID";
var GATEWAY_SHARED_SECRET_PROPERTY_ = "TYPED_SHEETS_GATEWAY_SHARED_SECRET";
var LEGACY_GATEWAY_SHEET_ID_PROPERTY_ = "TYPED_SHEETS_MVP_SHEET_ID";
var LEGACY_GATEWAY_SHARED_SECRET_PROPERTY_ = "TYPED_SHEETS_MVP_SHARED_SECRET";
var GATEWAY_INTERNAL_SHEET_PROTECTION_PREFIX_ = "typed-sheets internal sheet: ";
var GATEWAY_MAX_CLOCK_SKEW_MS_ = 60 * 1000;
var GATEWAY_MAX_REQUEST_LIFETIME_MS_ = 10 * 60 * 1000;
var GATEWAY_LOCK_TIMEOUT_MS_ = 20 * 1000;

var SYNC_PROTOCOL_VERSION_ = "typed-sheets-sync-v1";
var SYNC_ADMIN_PROTOCOL_VERSION_ = "typed-sheets-sync-admin-v1";
var SYNC_REGISTRY_PROPERTY_ = "TYPED_SHEETS_SYNC_REGISTRY";
var SYNC_RECEIPT_SHEET_NAME_ = "__typed_sheets_internal_effect_receipts";
var SYNC_RECEIPT_HEADERS_ = ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"];
var SYNC_ANCHOR_KEY_ = "typed_sheets_sync_anchor";
var SYNC_VISIBLE_REVISION_KEY_ = "typed_sheets_sync_visible_revision";
var SYNC_VISIBLE_HASH_KEY_ = "typed_sheets_sync_visible_hash";
var SYNC_MAX_EFFECTS_PER_REQUEST_ = 20;
var SYNC_OPERATIONS_ = {
  ensureRowAnchors: true,
  readSnapshot: true,
  readEffectPostcondition: true,
  applyEffects: true,
};
var SYNC_ADMIN_OPERATIONS_ = {
  provisionRegistry: true,
};

// Optional non-interactive setup input. Normally setupSyncGateway() prompts
// for this value, but it can be pasted here when the editor has no Sheet UI.
var TYPED_SHEETS_GATEWAY_URL = "";

/** Web-app entry point. Every useful operation must be a signed POST. */
function doPost(event) {
  try {
    return jsonOutput_(handlePost_(event));
  } catch (error) {
    return jsonOutput_(failure_("internal_error", safeErrorMessage_(error)));
  }
}

/** Rejects unauthenticated GET calls instead of exposing spreadsheet metadata. */
function doGet() {
  return jsonOutput_(failure_("method_not_allowed", "Use a signed POST request."));
}

/** Runs the stable-encoding self-test used by normalized snapshot hashing. */
function runSyncGatewaySelfTest() {
  return runStableEncodingSelfTest_();
}

/**
 * Configures this bound spreadsheet for the registry-bound sync gateway.
 *
 * Run this manually from the Apps Script editor after deploying the web app.
 * It prompts for the deployed `/exec` URL, generates a shared secret only when
 * one is absent, and logs a copyable local `.env` block. It is never reachable
 * through doPost(), so the secret is not exposed by the public gateway.
 *
 * @returns {object|null} Local runner config, or null when setup is cancelled.
 */
function setupSyncGateway() {
  var gatewayUrl = requestSyncGatewayUrlForSetup_();
  if (gatewayUrl === null) return null;

  var config = configureSyncGateway_(gatewayUrl);
  Logger.log(config.localEnv);
  return config;
}

/**
 * Uses an editor prompt when available, with a source-level fallback for
 * manual execution contexts that cannot open a Google Sheets dialog.
 */
function requestSyncGatewayUrlForSetup_() {
  if (typeof TYPED_SHEETS_GATEWAY_URL === "string" && TYPED_SHEETS_GATEWAY_URL.trim() !== "") {
    return TYPED_SHEETS_GATEWAY_URL;
  }

  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (error) {
    throw new Error(
      "Paste the deployed /exec URL into TYPED_SHEETS_GATEWAY_URL before running setupSyncGateway() from a non-Sheet UI context.",
    );
  }

  var response = ui.prompt(
    "Configure typed-sheets sync gateway",
    "Paste the deployed Apps Script Web App URL ending in /exec.",
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  return response.getResponseText();
}

/**
 * Saves the allowlisted sheet ID and shared secret under a script lock so two
 * manual setup executions cannot accidentally rotate the generated secret.
 */
function configureSyncGateway_(gatewayUrl) {
  var normalizedGatewayUrl = requireSyncGatewayUrl_(gatewayUrl);
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet === null) {
    throw new Error("setupSyncGateway() must run from the bound spreadsheet's Apps Script project.");
  }

  var sheetId = spreadsheet.getId();
  if (!isNonEmptyString_(sheetId)) {
    throw new Error("Could not resolve the bound disposable spreadsheet ID.");
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(GATEWAY_LOCK_TIMEOUT_MS_)) {
    throw new Error("Could not acquire the sync gateway setup lock.");
  }

  try {
    var properties = PropertiesService.getScriptProperties();
    var existingSecret = properties.getProperty(GATEWAY_SHARED_SECRET_PROPERTY_) ||
      properties.getProperty(LEGACY_GATEWAY_SHARED_SECRET_PROPERTY_);
    var sharedSecret = isNonEmptyString_(existingSecret) ? existingSecret : createSyncGatewaySharedSecret_();

    properties.setProperty(GATEWAY_SHEET_ID_PROPERTY_, sheetId);
    properties.setProperty(GATEWAY_SHARED_SECRET_PROPERTY_, sharedSecret);

    return {
      gatewayUrl: normalizedGatewayUrl,
      sheetId: sheetId,
      sharedSecret: sharedSecret,
      localEnv: formatSyncGatewayLocalEnv_(normalizedGatewayUrl, sharedSecret, sheetId),
    };
  } finally {
    lock.releaseLock();
  }
}

/** Validates a deployed Apps Script Web App URL before it is copied locally. */
function requireSyncGatewayUrl_(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Paste a deployed Apps Script Web App URL ending in /exec before running setupSyncGateway().");
  }

  var gatewayUrl = value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(gatewayUrl)) {
    throw new Error("Sync gateway URL must be a deployed Apps Script Web App URL ending in /exec.");
  }
  return gatewayUrl;
}

/** Generates a long URL-safe secret only for the trusted editor setup path. */
function createSyncGatewaySharedSecret_() {
  return Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
}

/** Formats the exact local environment values consumed by the Node sync runners. */
function formatSyncGatewayLocalEnv_(gatewayUrl, sharedSecret, sheetId) {
  return [
    "# Keep this untracked. The shared secret grants gateway access.",
    "TYPED_SHEETS_GATEWAY_URL=" + JSON.stringify(gatewayUrl),
    "TYPED_SHEETS_GATEWAY_SHARED_SECRET=" + JSON.stringify(sharedSecret),
    "TYPED_SHEETS_GATEWAY_SHEET_ID=" + JSON.stringify(sheetId),
  ].join("\n");
}

/** Reads the configured gateway identity, accepting one prior property namespace during migration. */
function readGatewayConfiguration_() {
  var properties = PropertiesService.getScriptProperties();
  var sheetId = properties.getProperty(GATEWAY_SHEET_ID_PROPERTY_) ||
    properties.getProperty(LEGACY_GATEWAY_SHEET_ID_PROPERTY_);
  var sharedSecret = properties.getProperty(GATEWAY_SHARED_SECRET_PROPERTY_) ||
    properties.getProperty(LEGACY_GATEWAY_SHARED_SECRET_PROPERTY_);
  if (!isNonEmptyString_(sheetId) || !isNonEmptyString_(sharedSecret)) return null;
  return { sheetId: sheetId, sharedSecret: sharedSecret };
}

function handlePost_(event) {
  if (!event || !event.postData || typeof event.postData.contents !== "string") {
    return failure_("invalid_request", "Expected a JSON POST body.");
  }

  var envelope;
  try {
    envelope = JSON.parse(event.postData.contents);
  } catch (error) {
    return failure_("invalid_json", "Request body is not valid JSON.");
  }

  if (isPlainObject_(envelope) && envelope.protocolVersion === SYNC_ADMIN_PROTOCOL_VERSION_) {
    return handleSyncAdminPost_(envelope);
  }
  if (isPlainObject_(envelope) && envelope.protocolVersion === SYNC_PROTOCOL_VERSION_) {
    return handleSyncPost_(envelope);
  }
  return failure_("unsupported_protocol", "Unsupported sync protocol version.");
}

/**
 * Creates or verifies every trusted SQLite projection, then atomically swaps
 * the remote route allowlist only after every header has passed validation.
 *
 * Existing nonblank headers are never rewritten. A schema mismatch therefore
 * fails before the route becomes active instead of silently changing a user
 * tab under an operator's feet.
 */
function provisionSyncGatewayRegistry_(spreadsheet, payload) {
  var entries = requireSyncProvisionRegistrations_(payload);
  var createdSheets = [];
  var initializedHeaders = [];

  entries.forEach(function (entry) {
    var provisioned = ensureSyncProjectionSheet_(spreadsheet, entry);
    if (provisioned.created) createdSheets.push(entry.route.sheetName);
    if (provisioned.initializedHeaders) initializedHeaders.push(entry.route.sheetName);
  });

  var registry = entries.map(function (entry) { return entry.route; });
  PropertiesService.getScriptProperties().setProperty(SYNC_REGISTRY_PROPERTY_, canonicalJson_(registry));
  return {
    registrations: registry,
    createdSheets: createdSheets,
    initializedHeaders: initializedHeaders,
  };
}

/** Validates a complete set of source-owned routes and exact header definitions. */
function requireSyncProvisionRegistrations_(payload) {
  if (!isPlainObject_(payload) || !Array.isArray(payload.registrations) || payload.registrations.length === 0) {
    throw new Error("provisionRegistry payload must contain one or more registrations.");
  }
  if (payload.registrations.length > 20) {
    throw new Error("provisionRegistry exceeds the maximum of 20 projections.");
  }

  var seenSheets = {};
  var routes = [];
  return payload.registrations.map(function (entry) {
    if (!isPlainObject_(entry)) throw new Error("provisionRegistry registration must be an object.");
    var route = normalizeSyncRegistry_([entry])[0];
    if (seenSheets[route.sheetName]) {
      throw new Error("provisionRegistry cannot configure the same tab more than once.");
    }
    seenSheets[route.sheetName] = true;
    var key = [route.sheetName, route.registeredRange, route.projection, route.schemaVersion].join("\u0000");
    if (routes.indexOf(key) >= 0) throw new Error("provisionRegistry contains a duplicate route.");
    routes.push(key);

    if (!Array.isArray(entry.headers)) {
      throw new Error("provisionRegistry headers must be an array.");
    }
    var headers = validateHeaders_(entry.headers);
    var columns = syncRegisteredColumns_(route);
    if (headers.length !== columns.columnCount) {
      throw new Error("provisionRegistry headers must exactly match the registered range width.");
    }
    validateSyncCheckboxHeaders_(route.checkboxHeaders || [], headers);
    return { route: route, headers: headers };
  });
}

/** Creates a missing projection tab or verifies its header without overwriting a schema. */
function ensureSyncProjectionSheet_(spreadsheet, entry) {
  var sheet = spreadsheet.getSheetByName(entry.route.sheetName);
  var created = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(entry.route.sheetName);
    created = true;
  }
  var columns = syncRegisteredColumns_(entry.route);
  var range = sheet.getRange(1, columns.startColumn, 1, columns.columnCount);
  var actual = range.getValues()[0];
  var initializedHeaders = false;
  if (isBlankRow_(actual)) {
    range.setValues([entry.headers]);
    initializedHeaders = true;
  } else {
    for (var index = 0; index < entry.headers.length; index += 1) {
      if (actual[index] !== entry.headers[index]) {
        throw new Error("Registered projection " + entry.route.sheetName + " has unexpected headers and will not be overwritten.");
      }
    }
  }
  applySyncCheckboxValidationToExistingRows_(sheet, entry.route);
  if (entry.route.projection === "system_state") {
    // SQLite owns this projection, so never leave it as an editable user tab.
    protectAndHideInternalSheet_(sheet, entry.route.sheetName);
  }
  return { created: created, initializedHeaders: initializedHeaders };
}

/**
 * Applies checkbox validation only to materialized projection rows.
 *
 * A whole-column checkbox range makes Sheets materialize unchecked FALSE cells
 * on otherwise empty rows. That turns future blank rows into expensive snapshot
 * candidates, so provisioning clears that legacy shape and validates only rows
 * that already carry a projection record. New rows are validated on append.
 */
function applySyncCheckboxValidationToExistingRows_(sheet, registration) {
  var checkboxHeaders = registration.checkboxHeaders || [];
  if (checkboxHeaders.length === 0) return;
  var columns = syncRegisteredColumns_(registration);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var headers = validateHeaders_(sheet.getRange(1, columns.startColumn, 1, columns.columnCount).getValues()[0]);
  var checkboxColumnIndexes = syncCheckboxColumnIndexes_(headers, registration);
  var values = sheet.getRange(2, columns.startColumn, lastRow - 1, columns.columnCount).getValues();

  clearUncheckedCheckboxValuesForBlankRows_(sheet, columns, values, checkboxColumnIndexes);
  Object.keys(checkboxColumnIndexes).forEach(function (indexText) {
    var columnIndex = Number(indexText);
    var validation = SpreadsheetApp.newDataValidation()
      .requireCheckbox()
      .setAllowInvalid(false)
      .build();
    var validations = values.map(function (row) {
      return [isBlankSyncProjectionRow_(row, checkboxColumnIndexes) ? null : validation];
    });
    sheet.getRange(2, columns.startColumn + columnIndex, values.length, 1).setDataValidations(validations);
  });
}

/** Clears only unchecked checkbox remnants on rows that contain no projection data. */
function clearUncheckedCheckboxValuesForBlankRows_(sheet, columns, values, checkboxColumnIndexes) {
  Object.keys(checkboxColumnIndexes).forEach(function (indexText) {
    var columnIndex = Number(indexText);
    var startOffset = null;
    for (var rowOffset = 0; rowOffset <= values.length; rowOffset += 1) {
      var shouldClear = rowOffset < values.length &&
        values[rowOffset][columnIndex] === false &&
        isBlankSyncProjectionRow_(values[rowOffset], checkboxColumnIndexes);
      if (shouldClear && startOffset === null) {
        startOffset = rowOffset;
        continue;
      }
      if ((!shouldClear || rowOffset === values.length) && startOffset !== null) {
        sheet.getRange(
          startOffset + 2,
          columns.startColumn + columnIndex,
          rowOffset - startOffset,
          1,
        ).clearContent();
        startOffset = null;
      }
    }
  });
}

/** Returns true when a row has no projection data other than unchecked controls. */
function isBlankSyncProjectionRow_(row, checkboxColumnIndexes) {
  return row.every(function (cell, index) {
    if (checkboxColumnIndexes[index]) return cell === "" || cell === null || cell === false;
    return cell === "" || cell === null;
  });
}

/** Resolves declared checkbox headers to zero-based positions in one registered row. */
function syncCheckboxColumnIndexes_(headers, registration) {
  var indexes = {};
  (registration.checkboxHeaders || []).forEach(function (header) {
    var index = headers.indexOf(header);
    if (index < 0) throw new Error("Checkbox header is missing from the registered projection: " + header);
    indexes[index] = true;
  });
  return indexes;
}

/** Applies trusted checkbox validation to one known materialized projection row. */
function applySyncCheckboxValidation_(sheet, registration, startRow, rowCount) {
  var checkboxHeaders = registration.checkboxHeaders || [];
  if (checkboxHeaders.length === 0 || rowCount <= 0) return;
  var layout = syncProjectionHeaderLayout_(sheet, registration);
  checkboxHeaders.forEach(function (header) {
    var column = layout.positions[header];
    if (!column) throw new Error("Checkbox header is missing from the registered projection: " + header);
    var validation = SpreadsheetApp.newDataValidation()
      .requireCheckbox()
      .setAllowInvalid(false)
      .build();
    sheet.getRange(startRow, column, rowCount, 1).setDataValidation(validation);
  });
}

/** Routes a signed general sync request after separate envelope validation. */
function handleSyncPost_(envelope) {
  var validation = validateSyncEnvelope_(envelope);
  if (validation.failure !== null) return validation.failure;
  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(envelope.sheetId);
  } catch (error) {
    return failure_("sheet_open_failed", "Configured sync spreadsheet could not be opened.");
  }
  var registration = validation.registration;
  if (envelope.operation === "readSnapshot") {
    try {
      return success_(readSyncSnapshot_(spreadsheet, registration));
    } catch (error) {
      return failure_("snapshot_failed", safeErrorMessage_(error));
    }
  }
  if (envelope.operation === "readEffectPostcondition") {
    try {
      return success_(readSyncEffectPostcondition_(spreadsheet, registration, envelope.payload));
    } catch (error) {
      return failure_("postcondition_failed", safeErrorMessage_(error));
    }
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(GATEWAY_LOCK_TIMEOUT_MS_)) {
    return failure_("lock_timeout", "Could not acquire the sync gateway write lock.");
  }
  try {
    var result;
    if (envelope.operation === "ensureRowAnchors") {
      result = ensureSyncRowAnchors_(spreadsheet, registration);
    } else if (envelope.operation === "applyEffects") {
      result = applySyncEffects_(spreadsheet, registration, envelope.payload);
    } else {
      return failure_("unsupported_operation", "Sync operation is not implemented.");
    }
    SpreadsheetApp.flush();
    return success_(result);
  } catch (error) {
    return failure_("operation_failed", safeErrorMessage_(error));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Provisions the complete SQLite-declared projection registry through a signed
 * control-plane request. This is the one automated setup path; data-plane
 * requests still cannot create or widen a route.
 */
function handleSyncAdminPost_(envelope) {
  var validation = validateSyncAdminEnvelope_(envelope);
  if (validation !== null) return validation;
  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(envelope.sheetId);
  } catch (error) {
    return failure_("sheet_open_failed", "Configured sync spreadsheet could not be opened.");
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(GATEWAY_LOCK_TIMEOUT_MS_)) {
    return failure_("lock_timeout", "Could not acquire the sync gateway setup lock.");
  }
  try {
    if (envelope.operation !== "provisionRegistry") {
      return failure_("unsupported_operation", "Sync control-plane operation is not implemented.");
    }
    var result = provisionSyncGatewayRegistry_(spreadsheet, envelope.payload);
    SpreadsheetApp.flush();
    return success_(result);
  } catch (error) {
    return failure_("provision_failed", safeErrorMessage_(error));
  } finally {
    lock.releaseLock();
  }
}

/** Validates the sync envelope and resolves its immutable registry record. */
function validateSyncEnvelope_(envelope) {
  if (!isPlainObject_(envelope)) return { failure: failure_("invalid_envelope", "Envelope must be a JSON object."), registration: null };
  if (envelope.protocolVersion !== SYNC_PROTOCOL_VERSION_) {
    return { failure: failure_("unsupported_protocol", "Unsupported sync protocol version."), registration: null };
  }
  if (!isNonEmptyString_(envelope.requestId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(envelope.requestId)) {
    return { failure: failure_("invalid_request_id", "Request ID must be 8-128 URL-safe characters."), registration: null };
  }
  if (!isNonEmptyString_(envelope.operation) || !SYNC_OPERATIONS_[envelope.operation]) {
    return { failure: failure_("unsupported_operation", "Operation is not allowlisted."), registration: null };
  }
  if (!isNonEmptyString_(envelope.keyId) || !isNonEmptyString_(envelope.sheetId) ||
      !isNonEmptyString_(envelope.registeredRange) || !isNonEmptyString_(envelope.actorId) ||
      !isNonEmptyString_(envelope.bodyHash) || !isNonEmptyString_(envelope.signature)) {
    return { failure: failure_("invalid_envelope", "Sync envelope is missing an authenticated field."), registration: null };
  }
  if (!isPositiveSafeInteger_(envelope.issuedAt) || !isPositiveSafeInteger_(envelope.expiresAt)) {
    return { failure: failure_("invalid_time", "issuedAt and expiresAt must be positive epoch milliseconds."), registration: null };
  }
  var now = Date.now();
  if (envelope.issuedAt > now + GATEWAY_MAX_CLOCK_SKEW_MS_ || envelope.expiresAt < now ||
      envelope.expiresAt <= envelope.issuedAt || envelope.expiresAt - envelope.issuedAt > GATEWAY_MAX_REQUEST_LIFETIME_MS_) {
    return { failure: failure_("invalid_expiry", "Sync envelope is expired or outside the allowed lifetime."), registration: null };
  }
  var gateway = readGatewayConfiguration_();
  if (gateway === null) {
    return { failure: failure_("gateway_not_configured", "Required Script Properties are not configured."), registration: null };
  }
  if (gateway.sheetId !== envelope.sheetId) {
    return { failure: failure_("sheet_not_allowlisted", "Envelope sheetId is not the configured spreadsheet."), registration: null };
  }
  if (envelope.keyId !== "typed-sheets-shared-secret-v1") {
    return { failure: failure_("unknown_key", "Sync keyId is not configured."), registration: null };
  }
  var actualBodyHash;
  try {
    actualBodyHash = sha256Hex_(canonicalJson_(envelope.payload));
  } catch (error) {
    return { failure: failure_("invalid_payload", safeErrorMessage_(error)), registration: null };
  }
  if (!constantTimeEquals_(actualBodyHash, envelope.bodyHash)) {
    return { failure: failure_("body_hash_mismatch", "Payload does not match the signed body hash."), registration: null };
  }
  if (!constantTimeEquals_(hmacSha256Base64Url_(syncSigningInput_(envelope), gateway.sharedSecret), envelope.signature)) {
    return { failure: failure_("invalid_signature", "Sync envelope signature could not be verified."), registration: null };
  }
  var registration;
  try {
    registration = requireSyncRegistrationForPayload_(envelope.payload, envelope.registeredRange);
  } catch (error) {
    return { failure: failure_("sheet_not_allowlisted", safeErrorMessage_(error)), registration: null };
  }
  return { failure: null, registration: registration };
}

/** Validates a route-provisioning envelope before it can open or change a Sheet. */
function validateSyncAdminEnvelope_(envelope) {
  if (!isPlainObject_(envelope)) return failure_("invalid_envelope", "Envelope must be a JSON object.");
  if (envelope.protocolVersion !== SYNC_ADMIN_PROTOCOL_VERSION_) {
    return failure_("unsupported_protocol", "Unsupported sync control-plane protocol version.");
  }
  if (!isNonEmptyString_(envelope.requestId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(envelope.requestId)) {
    return failure_("invalid_request_id", "Request ID must be 8-128 URL-safe characters.");
  }
  if (!isNonEmptyString_(envelope.operation) || !SYNC_ADMIN_OPERATIONS_[envelope.operation]) {
    return failure_("unsupported_operation", "Control-plane operation is not allowlisted.");
  }
  if (!isNonEmptyString_(envelope.keyId) || !isNonEmptyString_(envelope.sheetId) ||
      !isNonEmptyString_(envelope.actorId) || !isNonEmptyString_(envelope.bodyHash) ||
      !isNonEmptyString_(envelope.signature)) {
    return failure_("invalid_envelope", "Sync control-plane envelope is missing an authenticated field.");
  }
  if (!isPositiveSafeInteger_(envelope.issuedAt) || !isPositiveSafeInteger_(envelope.expiresAt)) {
    return failure_("invalid_time", "issuedAt and expiresAt must be positive epoch milliseconds.");
  }
  var now = Date.now();
  if (envelope.issuedAt > now + GATEWAY_MAX_CLOCK_SKEW_MS_ || envelope.expiresAt < now ||
      envelope.expiresAt <= envelope.issuedAt || envelope.expiresAt - envelope.issuedAt > GATEWAY_MAX_REQUEST_LIFETIME_MS_) {
    return failure_("invalid_expiry", "Sync control-plane envelope is expired or outside the allowed lifetime.");
  }
  var gateway = readGatewayConfiguration_();
  if (gateway === null) {
    return failure_("gateway_not_configured", "Required Script Properties are not configured.");
  }
  if (gateway.sheetId !== envelope.sheetId) {
    return failure_("sheet_not_allowlisted", "Envelope sheetId is not the configured spreadsheet.");
  }
  if (envelope.keyId !== "typed-sheets-shared-secret-v1") {
    return failure_("unknown_key", "Sync keyId is not configured.");
  }
  var actualBodyHash;
  try {
    actualBodyHash = sha256Hex_(canonicalJson_(envelope.payload));
  } catch (error) {
    return failure_("invalid_payload", safeErrorMessage_(error));
  }
  if (!constantTimeEquals_(actualBodyHash, envelope.bodyHash)) {
    return failure_("body_hash_mismatch", "Payload does not match the signed body hash.");
  }
  if (!constantTimeEquals_(hmacSha256Base64Url_(syncAdminSigningInput_(envelope), gateway.sharedSecret), envelope.signature)) {
    return failure_("invalid_signature", "Sync control-plane signature could not be verified.");
  }
  return null;
}

/** Ensures registered rows have exactly one sync-owned Developer Metadata anchor. */
function ensureSyncRowAnchors_(spreadsheet, registration) {
  var sheet = requireSyncSheet_(spreadsheet, registration);
  var columns = syncRegisteredColumns_(registration);
  var headers = validateHeaders_(sheet.getRange(1, columns.startColumn, 1, columns.columnCount).getValues()[0]);
  var checkboxColumnIndexes = syncCheckboxColumnIndexes_(headers, registration);
  var lastRow = sheet.getLastRow();
  var assigned = 0;
  var existing = 0;
  if (lastRow > 1) {
    var values = sheet.getRange(2, columns.startColumn, lastRow - 1, columns.columnCount).getValues();
    values.forEach(function (row, index) {
      if (isBlankSyncProjectionRow_(row, checkboxColumnIndexes)) return;
      var rowNumber = index + 2;
      var anchors = getSyncRowAnchors_(sheet, rowNumber);
      ensureSyncRowAnchor_(sheet, rowNumber);
      if (anchors.length === 0) assigned += 1;
      else existing += 1;
    });
  }
  return {
    assigned: assigned,
    existing: existing,
    duplicateAnchors: findDuplicateSyncAnchors_(sheet, columns, checkboxColumnIndexes),
  };
}

/** Returns a metadata-rich normalized snapshot for exactly one registry entry. */
function readSyncSnapshot_(spreadsheet, registration) {
  var sheet = requireSyncSheet_(spreadsheet, registration);
  var columns = syncRegisteredColumns_(registration);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var range = sheet.getRange(1, columns.startColumn, lastRow, columns.columnCount);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var displayValues = range.getDisplayValues();
  var headers = validateHeaders_(values[0]);
  var checkboxColumnIndexes = syncCheckboxColumnIndexes_(headers, registration);
  var mergeMap = mergedCellMap_(range);
  var rows = [];
  var unanchoredRows = [];
  var anchorRows = {};
  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    if (isBlankSyncProjectionRow_(values[rowIndex], checkboxColumnIndexes)) continue;
    var rowNumber = rowIndex + 1;
    var anchors = getSyncRowAnchors_(sheet, rowNumber);
    var anchor = anchors.length === 1 ? anchors[0] : null;
    if (anchor === null) unanchoredRows.push(rowNumber);
    else {
      if (!anchorRows[anchor]) anchorRows[anchor] = [];
      anchorRows[anchor].push(rowNumber);
    }
    var visible = readSyncVisibleMetadata_(sheet, rowNumber);
    var cells = {};
    for (var columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      var coordinate = rowNumber + ":" + (columns.startColumn + columnIndex);
      cells[headers[columnIndex]] = normalizeCellObservation_(
        values[rowIndex][columnIndex],
        formulas[rowIndex][columnIndex],
        displayValues[rowIndex][columnIndex],
        mergeMap[coordinate] || null,
      );
    }
    rows.push({
      rowNumber: rowNumber,
      physicalAnchor: anchor,
      visibleRevision: visible.visibleRevision,
      visibleHash: visible.visibleHash,
      cells: cells,
    });
  }
  var duplicateAnchors = [];
  Object.keys(anchorRows).sort().forEach(function (anchor) {
    if (anchorRows[anchor].length > 1) duplicateAnchors.push({ anchor: anchor, rowNumbers: anchorRows[anchor] });
  });
  var snapshot = {
    protocolVersion: SYNC_PROTOCOL_VERSION_,
    sheetName: registration.sheetName,
    registeredRange: registration.registeredRange,
    projection: registration.projection,
    schemaVersion: registration.schemaVersion,
    headers: headers,
    rows: rows,
  };
  return {
    protocolVersion: snapshot.protocolVersion,
    sheetName: snapshot.sheetName,
    registeredRange: snapshot.registeredRange,
    projection: snapshot.projection,
    schemaVersion: snapshot.schemaVersion,
    headers: snapshot.headers,
    rows: snapshot.rows,
    snapshotHash: sha256Hex_(canonicalJson_(snapshot)),
    unanchoredRows: unanchoredRows,
    duplicateAnchors: duplicateAnchors,
  };
}

/**
 * Reads receipt-backed evidence for a resolved-conflict deletion after a lost response.
 *
 * A missing row alone is deliberately not success evidence: only this exact
 * effect's durable receipt can prove that the gateway deleted the anchored
 * control row instead of an editor removing it manually.
 */
function readSyncEffectPostcondition_(spreadsheet, registration, payload) {
  if (!isPlainObject_(payload)) throw new Error("readEffectPostcondition payload must be an object.");
  var checked = requireSyncEffect_(requireObjectField_(payload, "effect"), registration);
  if (checked.effectKind !== "resolution_delete") {
    throw new Error("readEffectPostcondition is only supported for resolution_delete.");
  }
  var sheet = requireSyncSheet_(spreadsheet, registration);
  var receiptSheet = spreadsheet.getSheetByName(SYNC_RECEIPT_SHEET_NAME_);
  var receipt = receiptSheet ? findSyncReceipt_(receiptSheet, checked.effectId) : null;
  if (receipt !== null && !constantTimeEquals_(receipt.payloadHash, checked.payloadHash)) {
    throw new Error("effect ID was reused with a different payload.");
  }
  var rowNumber = findSyncRowByAnchor_(sheet, registration, checked.payload.targetAnchor);
  if (receipt !== null && rowNumber === null) {
    return {
      disposition: "applied",
      visibleRevision: receipt.visibleRevision,
      visibleHash: receipt.visibleHash,
      // Recovery does not need a full-sheet snapshot. Avoid turning a rare
      // response-loss probe into a scan of every unresolved conflict row.
      snapshotHash: null,
    };
  }
  if (rowNumber === null) {
    return { disposition: "unavailable", visibleRevision: null, visibleHash: null, snapshotHash: null };
  }
  var visible = readSyncVisibleMetadata_(sheet, rowNumber);
  var currentRevision = visible.visibleRevision === null ? 0 : visible.visibleRevision;
  var currentHash = syncVisibleHashForSheetRow_(sheet, rowNumber, checked.payload.fields, registration);
  if (receipt !== null) {
    return {
      disposition: "changed",
      visibleRevision: currentRevision,
      visibleHash: currentHash,
      snapshotHash: null,
    };
  }
  if (currentRevision === checked.expectedVisibleRevision &&
      constantTimeEquals_(currentHash, checked.expectedVisibleHash)) {
    return {
      disposition: "unapplied",
      visibleRevision: currentRevision,
      visibleHash: currentHash,
      snapshotHash: null,
    };
  }
  return {
    disposition: "changed",
    visibleRevision: currentRevision,
    visibleHash: currentHash,
    snapshotHash: null,
  };
}

/** Applies a bounded prefix of same-projection effects under the caller's lock. */
function applySyncEffects_(spreadsheet, registration, payload) {
  if (!isPlainObject_(payload) || !Array.isArray(payload.effects)) {
    throw new Error("applyEffects payload must contain an effects array.");
  }
  var sheet = requireSyncSheet_(spreadsheet, registration);
  var effects = payload.effects;
  var count = Math.min(effects.length, SYNC_MAX_EFFECTS_PER_REQUEST_);
  var results = [];
  for (var index = 0; index < count; index += 1) {
    results.push(applySyncEffect_(spreadsheet, sheet, registration, effects[index]));
  }
  // A batch snapshot is read after every bounded prefix has settled. It is
  // advisory batch evidence (not a per-effect CAS value), but returning it on
  // each result lets a caller retain one authenticated recovery checkpoint.
  var snapshotHash = readSyncSnapshot_(spreadsheet, registration).snapshotHash;
  results.forEach(function (result) { result.snapshotHash = snapshotHash; });
  return {
    results: results,
    snapshotHash: snapshotHash,
    hasMore: effects.length > count,
  };
}

/** Performs one read-check-write-postcondition effect without choosing canonical state. */
function applySyncEffect_(spreadsheet, sheet, registration, effect) {
  var checked = requireSyncEffect_(effect, registration);
  var receiptSheet = ensureInternalSheetWithHeaders_(spreadsheet, SYNC_RECEIPT_SHEET_NAME_, SYNC_RECEIPT_HEADERS_);
  var receipt = findSyncReceipt_(receiptSheet, checked.effectId);
  if (receipt !== null) {
    if (!constantTimeEquals_(receipt.payloadHash, checked.payloadHash)) {
      return syncEffectResult_(checked, "schema_error", null, "effect_id_reused_with_different_payload", null);
    }
    var receiptRow = findSyncRowByAnchor_(sheet, registration, checked.payload.targetAnchor);
    if (checked.effectKind === "resolution_delete") {
      if (receiptRow === null) return syncEffectResult_(checked, "already_applied", null, null, receipt);
      return syncEffectResult_(checked, "guard_mismatch", receiptRow, "receipt_target_reappeared", null);
    }
    if (receiptRow === null) {
      return syncEffectResult_(
        checked,
        checked.effectKind === "system_repair" ? "repair_reobserve" : "guard_mismatch",
        null,
        "receipt_target_missing",
        null,
      );
    }
    // A receipt proves a prior attempt, not the current Sheet postcondition.
    // Re-check the anchored row so a deleted or later-edited projection cannot
    // be mistaken for an idempotent success during response-loss recovery.
    var receiptVisible = readSyncVisibleMetadata_(sheet, receiptRow);
    var receiptHash = syncVisibleHashForSheetRow_(sheet, receiptRow, checked.payload.fields, registration);
    if (receiptVisible.visibleRevision !== receipt.visibleRevision ||
        receiptVisible.visibleHash !== receipt.visibleHash ||
        !constantTimeEquals_(receiptHash, checked.payload.targetVisibleHash)) {
      return syncEffectResult_(
        checked,
        checked.effectKind === "system_repair" ? "repair_reobserve" : "guard_mismatch",
        receiptRow,
        "receipt_postcondition_changed",
        null,
      );
    }
    return syncEffectResult_(checked, "already_applied", receiptRow, null, receipt);
  }

  var rowNumber = findSyncRowByAnchor_(sheet, registration, checked.payload.targetAnchor);
  var created = false;
  if (rowNumber === null) {
    if (!checked.payload.createIfMissing) {
      return syncEffectResult_(checked, "guard_mismatch", null, "target_anchor_missing", null);
    }
    if (checked.expectedVisibleRevision !== 0 || checked.expectedVisibleHash !== "") {
      return syncEffectResult_(checked, "guard_mismatch", null, "insert_requires_empty_visible_baseline", null);
    }
    rowNumber = appendSyncProjectionRow_(sheet, checked.payload, registration);
    created = true;
  }

  if (checked.effectKind === "resolution_delete") {
    return deleteSyncProjectionRow_(sheet, receiptSheet, registration, checked, rowNumber);
  }

  var visible = readSyncVisibleMetadata_(sheet, rowNumber);
  var currentRevision = visible.visibleRevision === null ? 0 : visible.visibleRevision;
  var currentHash = syncVisibleHashForSheetRow_(sheet, rowNumber, checked.payload.fields, registration);
  if (checked.effectKind === "candidate_reconcile" && checked.payload.expectedCandidateHash !== null) {
    // Candidate state is held by SQLite. A stale visible baseline is the only
    // safe Sheet-side signal; it prevents a reconcile from overwriting a user edit.
    if (currentRevision !== checked.expectedVisibleRevision || currentHash !== checked.expectedVisibleHash) {
      return syncEffectResult_(checked, "guard_mismatch", rowNumber, "candidate_guard_mismatch", null);
    }
  }

  if (currentHash === checked.payload.targetVisibleHash) {
    var alreadyRevision = currentRevision;
    if (created || visible.visibleRevision === null) {
      alreadyRevision = checked.expectedVisibleRevision + 1;
      writeSyncVisibleMetadata_(sheet, rowNumber, alreadyRevision, currentHash);
    }
    var already = makeSyncReceipt_(checked, currentHash, alreadyRevision);
    writeSyncReceipt_(receiptSheet, already);
    return syncEffectResult_(checked, created ? "applied" : "already_applied", rowNumber, null, already);
  }

  if (checked.effectKind === "system_repair") {
    if (checked.repairGuardHash === null || currentHash !== checked.repairGuardHash) {
      return syncEffectResult_(checked, "repair_reobserve", rowNumber, "repair_guard_mismatch", null);
    }
  } else if (
    currentRevision !== checked.expectedVisibleRevision ||
    currentHash !== checked.expectedVisibleHash
  ) {
    return syncEffectResult_(checked, "guard_mismatch", rowNumber, "visible_guard_mismatch", null);
  }

  writeSyncProjectionFields_(sheet, rowNumber, checked.payload.fields, registration);
  var nextRevision = currentRevision + 1;
  writeSyncVisibleMetadata_(sheet, rowNumber, nextRevision, checked.payload.targetVisibleHash);
  SpreadsheetApp.flush();
  var postHash = syncVisibleHashForSheetRow_(sheet, rowNumber, checked.payload.fields, registration);
  if (!constantTimeEquals_(postHash, checked.payload.targetVisibleHash)) {
    return syncEffectResult_(checked, "retryable_error", rowNumber, "postcondition_hash_mismatch", null);
  }
  var persisted = makeSyncReceipt_(checked, postHash, nextRevision);
  writeSyncReceipt_(receiptSheet, persisted);
  return syncEffectResult_(checked, "applied", rowNumber, null, persisted);
}

/** Deletes only a fully observed, system-owned resolved conflict control row. */
function deleteSyncProjectionRow_(sheet, receiptSheet, registration, checked, rowNumber) {
  if (checked.payload.createIfMissing || checked.expectedVisibleRevision < 1 ||
      !constantTimeEquals_(checked.payload.targetVisibleHash, checked.expectedVisibleHash)) {
    return syncEffectResult_(checked, "schema_error", rowNumber, "invalid_resolution_delete_guard", null);
  }
  var layout = syncProjectionHeaderLayout_(sheet, registration);
  var fieldNames = Object.keys(checked.payload.fields).sort();
  var headerNames = layout.headers.slice().sort();
  if (fieldNames.length !== headerNames.length) {
    return syncEffectResult_(checked, "schema_error", rowNumber, "resolution_delete_requires_full_row", null);
  }
  for (var fieldIndex = 0; fieldIndex < headerNames.length; fieldIndex += 1) {
    if (fieldNames[fieldIndex] !== headerNames[fieldIndex]) {
      return syncEffectResult_(checked, "schema_error", rowNumber, "resolution_delete_requires_full_row", null);
    }
  }
  var visible = readSyncVisibleMetadata_(sheet, rowNumber);
  var currentRevision = visible.visibleRevision === null ? 0 : visible.visibleRevision;
  var currentHash = syncVisibleHashForSheetRow_(sheet, rowNumber, checked.payload.fields, registration);
  if (currentRevision !== checked.expectedVisibleRevision ||
      !constantTimeEquals_(currentHash, checked.expectedVisibleHash)) {
    return syncEffectResult_(checked, "guard_mismatch", rowNumber, "visible_guard_mismatch", null);
  }
  var receipt = makeSyncReceipt_(checked, currentHash, currentRevision);
  sheet.deleteRow(rowNumber);
  SpreadsheetApp.flush();
  writeSyncReceipt_(receiptSheet, receipt);
  return syncEffectResult_(checked, "applied", null, null, receipt);
}

/** Validates the effect shape before any row lookup or write occurs. */
function requireSyncEffect_(effect, registration) {
  if (!isPlainObject_(effect)) throw new Error("effect must be an object.");
  var effectId = requireSafeString_(requireObjectField_(effect, "effectId"), "effectId");
  var payloadHash = requireSafeString_(requireObjectField_(effect, "payloadHash"), "payloadHash");
  var effectKind = requireSafeString_(requireObjectField_(effect, "effectKind"), "effectKind");
  if (["system_projection", "candidate_reconcile", "system_repair", "resolution_projection", "resolution_delete"].indexOf(effectKind) < 0) {
    throw new Error("unsupported sync effect kind.");
  }
  if (effect.projection !== registration.projection) throw new Error("effect projection is not registered for this request.");
  if (effectKind === "resolution_delete" && registration.projection !== "sync_conflicts") {
    throw new Error("resolution_delete is only allowed on sync_conflicts.");
  }
  if (!isPositiveOrZeroInteger_(effect.expectedVisibleRevision) || typeof effect.expectedVisibleHash !== "string") {
    throw new Error("effect visible guard is invalid.");
  }
  if (effect.repairGuardHash !== null && typeof effect.repairGuardHash !== "string") {
    throw new Error("effect repair guard is invalid.");
  }
  var payload = requireSyncEffectPayload_(requireObjectField_(effect, "payload"), registration);
  return {
    effectId: effectId,
    payloadHash: payloadHash,
    effectKind: effectKind,
    expectedVisibleRevision: effect.expectedVisibleRevision,
    expectedVisibleHash: effect.expectedVisibleHash,
    repairGuardHash: effect.repairGuardHash,
    payload: payload,
  };
}

/** Validates the serializable field write payload and its stable target hash. */
function requireSyncEffectPayload_(payload, registration) {
  if (!isPlainObject_(payload)) throw new Error("effect payload must be an object.");
  if (payload.sheetName !== registration.sheetName || payload.registeredRange !== registration.registeredRange ||
      payload.schemaVersion !== registration.schemaVersion) {
    throw new Error("effect payload does not match the registered projection.");
  }
  var targetAnchor = requireSafeString_(requireObjectField_(payload, "targetAnchor"), "targetAnchor");
  var targetVisibleHash = requireSafeString_(requireObjectField_(payload, "targetVisibleHash"), "targetVisibleHash");
  if (typeof payload.createIfMissing !== "boolean") throw new Error("effect createIfMissing must be boolean.");
  if (payload.expectedCandidateHash !== null && typeof payload.expectedCandidateHash !== "string") {
    throw new Error("effect expectedCandidateHash must be string or null.");
  }
  if (!isPlainObject_(payload.fields) || Object.keys(payload.fields).length === 0) {
    throw new Error("effect fields must be a non-empty object.");
  }
  var fields = {};
  Object.keys(payload.fields).sort().forEach(function (fieldName) {
    if (!isNonEmptyString_(fieldName)) throw new Error("effect field name is invalid.");
    fields[fieldName] = requireNormalizedCell_(payload.fields[fieldName]);
  });
  if (!constantTimeEquals_(syncVisibleHashForFields_(fields), targetVisibleHash)) {
    throw new Error("effect targetVisibleHash does not match its fields.");
  }
  return {
    sheetName: registration.sheetName,
    registeredRange: registration.registeredRange,
    schemaVersion: registration.schemaVersion,
    targetAnchor: targetAnchor,
    fields: fields,
    targetVisibleHash: targetVisibleHash,
    createIfMissing: payload.createIfMissing,
    expectedCandidateHash: payload.expectedCandidateHash,
  };
}

/** Returns a gateway result with only verified/observed projection metadata. */
function syncEffectResult_(effect, status, rowNumber, reason, receipt) {
  var revision = receipt ? receipt.visibleRevision : null;
  var hash = receipt ? receipt.visibleHash : null;
  if (rowNumber !== null && !receipt) {
    // The caller's sheet is not available here; this branch is filled by the
    // write path's receipt on success and remains intentionally nullable on guards.
    revision = null;
    hash = null;
  }
  return {
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    status: status,
    visibleRevision: revision,
    visibleHash: hash,
    snapshotHash: null,
    reason: reason,
    postcondition: receipt ? "verified" : "unavailable",
  };
}

/** Parses the owner-configured registry and rejects any duplicate route. */
function normalizeSyncRegistry_(registrations) {
  if (!Array.isArray(registrations) || registrations.length === 0) {
    throw new Error("Sync registry must contain at least one projection entry.");
  }
  var seen = {};
  return registrations.map(function (entry) {
    if (!isPlainObject_(entry)) throw new Error("Sync registry entry must be an object.");
    var sheetName = requireSafeString_(requireObjectField_(entry, "sheetName"), "sheetName");
    var registeredRange = normalizeSyncRegisteredRange_(
      requireSafeString_(requireObjectField_(entry, "registeredRange"), "registeredRange"),
    );
    var projection = requireSafeString_(requireObjectField_(entry, "projection"), "projection");
    var schemaVersion = requireObjectField_(entry, "schemaVersion");
    if (["user_input", "system_state", "sync_conflicts"].indexOf(projection) < 0 || !isPositiveSafeInteger_(schemaVersion)) {
      throw new Error("Sync registry projection or schemaVersion is invalid.");
    }
    var checkboxHeaders = normalizeSyncCheckboxHeaders_(entry.checkboxHeaders, projection);
    var key = [sheetName, registeredRange, projection, schemaVersion].join("\u0000");
    if (seen[key]) throw new Error("Sync registry contains a duplicate projection route.");
    seen[key] = true;
    var route = {
      sheetName: sheetName,
      registeredRange: registeredRange,
      projection: projection,
      schemaVersion: schemaVersion,
    };
    if (checkboxHeaders.length > 0) route.checkboxHeaders = checkboxHeaders;
    return route;
  });
}

/** Validates checkbox field names before a route is persisted in Script Properties. */
function normalizeSyncCheckboxHeaders_(value, projection) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Sync registry checkboxHeaders must be an array.");
  if (value.length > 0 && projection !== "sync_conflicts") {
    throw new Error("Sync registry checkboxHeaders are only allowed on sync_conflicts.");
  }
  var seen = {};
  return value.map(function (header) {
    var checked = requireSafeString_(header, "checkbox header");
    if (seen[checked]) throw new Error("Sync registry checkboxHeaders must be unique.");
    seen[checked] = true;
    return checked;
  });
}

/** Ensures every checkbox declaration names exactly one registered header. */
function validateSyncCheckboxHeaders_(checkboxHeaders, headers) {
  checkboxHeaders.forEach(function (header) {
    if (headers.indexOf(header) < 0) {
      throw new Error("Sync registry checkbox header is not a declared header: " + header);
    }
  });
}

/** Resolves an authenticated request only through the SQLite-provisioned allowlist. */
function requireSyncRegistrationForPayload_(payload, signedRange) {
  if (!isPlainObject_(payload)) throw new Error("Sync payload must be an object.");
  var sheetName = requireSafeString_(requireObjectField_(payload, "sheetName"), "sheetName");
  var registeredRange = normalizeSyncRegisteredRange_(
    requireSafeString_(requireObjectField_(payload, "registeredRange"), "registeredRange"),
  );
  var projection = requireSafeString_(requireObjectField_(payload, "projection"), "projection");
  var schemaVersion = requireObjectField_(payload, "schemaVersion");
  if (registeredRange !== signedRange || !isPositiveSafeInteger_(schemaVersion)) {
    throw new Error("Sync payload range or schemaVersion is invalid.");
  }
  var raw = PropertiesService.getScriptProperties().getProperty(SYNC_REGISTRY_PROPERTY_);
  if (!raw) throw new Error("Sync registry has not been configured in Script Properties.");
  var registry;
  try {
    registry = normalizeSyncRegistry_(JSON.parse(raw));
  } catch (error) {
    throw new Error("Sync registry is invalid: " + safeErrorMessage_(error));
  }
  for (var index = 0; index < registry.length; index += 1) {
    var entry = registry[index];
    if (entry.sheetName === sheetName && entry.registeredRange === registeredRange &&
        entry.projection === projection && entry.schemaVersion === schemaVersion) {
      return entry;
    }
  }
  throw new Error("Requested sheet/range/projection is not in the sync registry.");
}

/** Opens an already allowlisted physical tab; this never creates a user tab. */
function requireSyncSheet_(spreadsheet, registration) {
  var sheet = spreadsheet.getSheetByName(registration.sheetName);
  if (!sheet) throw new Error("Registered sync sheet does not exist: " + registration.sheetName);
  return sheet;
}

/**
 * Resolves the v1 whole-column allowlist to absolute Sheet columns.
 *
 * We deliberately support only `A:Z`-style ranges in v1. That keeps headers,
 * row anchors, snapshot cells, and writes inside exactly the same reviewed
 * projection boundary instead of accepting an A1 range and then reading the
 * rest of the tab by accident.
 */
function syncRegisteredColumns_(registration) {
  return parseSyncRegisteredRange_(registration.registeredRange);
}

/** Normalizes an owner-configured range before it is persisted as an allowlist. */
function normalizeSyncRegisteredRange_(value) {
  var normalized = String(value).trim().toUpperCase();
  parseSyncRegisteredRange_(normalized);
  return normalized;
}

/** Parses one bounded whole-column range such as `A:Z`. */
function parseSyncRegisteredRange_(value) {
  if (typeof value !== "string" || !/^[A-Z]+:[A-Z]+$/.test(value)) {
    throw new Error("Sync registeredRange must be an uppercase whole-column range such as A:Z.");
  }
  var parts = value.split(":");
  var startColumn = sheetColumnNumber_(parts[0]);
  var endColumn = sheetColumnNumber_(parts[1]);
  if (endColumn < startColumn) {
    throw new Error("Sync registeredRange end column must not precede its start column.");
  }
  return {
    startColumn: startColumn,
    endColumn: endColumn,
    columnCount: endColumn - startColumn + 1,
  };
}

/** Converts a Sheet column label to its one-based numeric position. */
function sheetColumnNumber_(letters) {
  var value = 0;
  for (var index = 0; index < letters.length; index += 1) {
    value = value * 26 + (letters.charCodeAt(index) - 64);
    if (!isPositiveSafeInteger_(value)) throw new Error("Sync registeredRange column is out of range.");
  }
  return value;
}

/** Returns exactly the sync anchors stored on one complete physical row. */
function getSyncRowAnchors_(sheet, rowNumber) {
  var anchors = [];
  sheet.getRange(rowNumber + ":" + rowNumber).getDeveloperMetadata().forEach(function (metadata) {
    if (metadata.getKey() === SYNC_ANCHOR_KEY_) anchors.push(metadata.getValue());
  });
  anchors.sort();
  return anchors;
}

/** Assigns one immutable metadata anchor, refusing an ambiguous pre-existing row. */
function ensureSyncRowAnchor_(sheet, rowNumber) {
  var anchors = getSyncRowAnchors_(sheet, rowNumber);
  if (anchors.length > 1) throw new Error("Row has multiple sync anchors and is ambiguous: " + rowNumber);
  if (anchors.length === 1) return anchors[0];
  var anchor = "sync-anchor:" + Utilities.getUuid();
  sheet.getRange(rowNumber + ":" + rowNumber).addDeveloperMetadata(
    SYNC_ANCHOR_KEY_, anchor, SpreadsheetApp.DeveloperMetadataVisibility.PROJECT,
  );
  return anchor;
}

/** Finds duplicate sync anchors without treating either row as the authoritative original. */
function findDuplicateSyncAnchors_(sheet, columns, checkboxColumnIndexes) {
  var grouped = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, columns.startColumn, lastRow - 1, columns.columnCount).getValues();
  values.forEach(function (row, index) {
    if (isBlankSyncProjectionRow_(row, checkboxColumnIndexes)) return;
    var rowNumber = index + 2;
    getSyncRowAnchors_(sheet, rowNumber).forEach(function (anchor) {
      if (!grouped[anchor]) grouped[anchor] = [];
      grouped[anchor].push(rowNumber);
    });
  });
  return Object.keys(grouped).sort().filter(function (anchor) {
    return grouped[anchor].length > 1;
  }).map(function (anchor) {
    return { anchor: anchor, rowNumbers: grouped[anchor] };
  });
}

/** Resolves a row only by its projection-local Developer Metadata anchor. */
function findSyncRowByAnchor_(sheet, registration, anchor) {
  var matches = [];
  var columns = syncRegisteredColumns_(registration);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var headers = validateHeaders_(sheet.getRange(1, columns.startColumn, 1, columns.columnCount).getValues()[0]);
  var checkboxColumnIndexes = syncCheckboxColumnIndexes_(headers, registration);
  var values = sheet.getRange(2, columns.startColumn, lastRow - 1, columns.columnCount).getValues();
  values.forEach(function (row, index) {
    if (isBlankSyncProjectionRow_(row, checkboxColumnIndexes)) return;
    var rowNumber = index + 2;
    if (getSyncRowAnchors_(sheet, rowNumber).indexOf(anchor) >= 0) matches.push(rowNumber);
  });
  if (matches.length > 1) throw new Error("Sync anchor is duplicated and cannot be used for a write.");
  return matches.length === 1 ? matches[0] : null;
}

/** Reads visible revision/hash from row metadata and rejects half-written metadata. */
function readSyncVisibleMetadata_(sheet, rowNumber) {
  var revision = getSyncRowMetadata_(sheet, rowNumber, SYNC_VISIBLE_REVISION_KEY_);
  var hash = getSyncRowMetadata_(sheet, rowNumber, SYNC_VISIBLE_HASH_KEY_);
  if (revision === null && hash === null) return { visibleRevision: null, visibleHash: null };
  if (revision === null || hash === null || !/^\d+$/.test(revision) || !isPositiveSafeInteger_(Number(revision)) || !isNonEmptyString_(hash)) {
    throw new Error("Sync row visible metadata is invalid or incomplete.");
  }
  return { visibleRevision: Number(revision), visibleHash: hash };
}

/** Replaces exactly this gateway's row metadata key, leaving unrelated metadata untouched. */
function writeSyncVisibleMetadata_(sheet, rowNumber, revision, hash) {
  setSyncRowMetadata_(sheet, rowNumber, SYNC_VISIBLE_REVISION_KEY_, String(revision));
  setSyncRowMetadata_(sheet, rowNumber, SYNC_VISIBLE_HASH_KEY_, hash);
}

function getSyncRowMetadata_(sheet, rowNumber, key) {
  var values = [];
  sheet.getRange(rowNumber + ":" + rowNumber).getDeveloperMetadata().forEach(function (metadata) {
    if (metadata.getKey() === key) values.push(metadata.getValue());
  });
  if (values.length > 1) throw new Error("Sync row has duplicate metadata key " + key + ".");
  return values.length === 0 ? null : values[0];
}

function setSyncRowMetadata_(sheet, rowNumber, key, value) {
  var range = sheet.getRange(rowNumber + ":" + rowNumber);
  range.getDeveloperMetadata().forEach(function (metadata) {
    if (metadata.getKey() === key) metadata.remove();
  });
  range.addDeveloperMetadata(key, value, SpreadsheetApp.DeveloperMetadataVisibility.PROJECT);
}

/** Appends a system-owned projection row with the effect's stable target anchor. */
function appendSyncProjectionRow_(sheet, payload, registration) {
  var layout = syncProjectionHeaderLayout_(sheet, registration);
  var headers = layout.headers;
  var values = headers.map(function (header) {
    if (!Object.prototype.hasOwnProperty.call(payload.fields, header)) return "";
    return normalizedCellToSheetValue_(payload.fields[header]);
  });
  var rowNumber = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(rowNumber, layout.startColumn, 1, headers.length).setValues([values]);
  applySyncCheckboxValidation_(sheet, registration, rowNumber, 1);
  setSyncRowMetadata_(sheet, rowNumber, SYNC_ANCHOR_KEY_, payload.targetAnchor);
  return rowNumber;
}

/** Writes only declared effect fields after confirming every field is in the registered header row. */
function writeSyncProjectionFields_(sheet, rowNumber, fields, registration) {
  var layout = syncProjectionHeaderLayout_(sheet, registration);
  var positions = layout.positions;
  Object.keys(fields).forEach(function (fieldName) {
    if (!positions[fieldName]) throw new Error("Effect field is not a registered header: " + fieldName);
    sheet.getRange(rowNumber, positions[fieldName]).setValue(normalizedCellToSheetValue_(fields[fieldName]));
  });
}

/** Re-reads only declared effect fields and computes the cross-runtime visible hash. */
function syncVisibleHashForSheetRow_(sheet, rowNumber, fields, registration) {
  var positions = syncProjectionHeaderLayout_(sheet, registration).positions;
  var values = {};
  Object.keys(fields).forEach(function (fieldName) {
    if (!positions[fieldName]) throw new Error("Effect field is not a registered header: " + fieldName);
    var raw = sheet.getRange(rowNumber, positions[fieldName]).getValue();
    values[fieldName] = normalizedCellFromSheetValue_(raw);
  });
  return syncVisibleHashForFields_(values);
}

/** Returns only the reviewed header cells and their absolute Sheet positions. */
function syncProjectionHeaderLayout_(sheet, registration) {
  var columns = syncRegisteredColumns_(registration);
  var headers = validateHeaders_(sheet.getRange(
    1, columns.startColumn, 1, columns.columnCount,
  ).getValues()[0]);
  var positions = {};
  headers.forEach(function (header, index) {
    positions[header] = columns.startColumn + index;
  });
  return { headers: headers, positions: positions, startColumn: columns.startColumn };
}

/** Uses stable_encode_v1, matching Node's computeSyncVisibleHash() exactly. */
function syncVisibleHashForFields_(fields) {
  var entries = Object.keys(fields).sort().map(function (fieldName) {
    return { fieldName: fieldName, value: fields[fieldName] };
  });
  return stableHash_({ fields: entries });
}

/** Validates the small NormalizedCell grammar accepted by the sync write path. */
function requireNormalizedCell_(value) {
  if (value === null) return null;
  if (!isPlainObject_(value)) throw new Error("Effect field must be a normalized cell.");
  if (value.kind === "string" && typeof value.value === "string") {
    return { kind: "string", value: normalizeScalarString_(value.value) };
  }
  if (value.kind === "number" && typeof value.value === "number" && isFinite(value.value)) {
    return { kind: "number", value: value.value };
  }
  if (value.kind === "boolean" && typeof value.value === "boolean") {
    return { kind: "boolean", value: value.value };
  }
  if (value.kind === "date" && typeof value.value === "string" && isCanonicalDateString_(value.value)) {
    return { kind: "date", value: value.value };
  }
  throw new Error("Effect field is not a supported normalized cell.");
}

function normalizedCellToSheetValue_(value) {
  if (value === null) return "";
  return value.kind === "date" ? value.value : value.value;
}

function normalizedCellFromSheetValue_(value) {
  if (value === "" || value === null) return null;
  if (isDate_(value)) return { kind: "date", value: value.toISOString() };
  if (typeof value === "string") return { kind: "string", value: normalizeScalarString_(value) };
  if (typeof value === "number" && isFinite(value)) return { kind: "number", value: value };
  if (typeof value === "boolean") return { kind: "boolean", value: value };
  throw new Error("Sheet value cannot be normalized for an effect postcondition.");
}

function isCanonicalDateString_(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

/** Locates a durable effect receipt without trusting row number as identity. */
function findSyncReceipt_(sheet, effectId) {
  if (sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, SYNC_RECEIPT_HEADERS_.length).getValues();
  var matches = [];
  rows.forEach(function (row, index) {
    if (String(row[0]) === effectId) matches.push({ rowNumber: index + 2, row: row });
  });
  if (matches.length > 1) throw new Error("Sync receipt sheet contains duplicate effectId values.");
  if (matches.length === 0) return null;
  var row = matches[0].row;
  var revision = Number(row[4]);
  if (!isPositiveOrZeroInteger_(revision) || !isNonEmptyString_(String(row[1])) || !isNonEmptyString_(String(row[2]))) {
    throw new Error("Sync receipt row is invalid.");
  }
  return {
    rowNumber: matches[0].rowNumber,
    payloadHash: String(row[1]),
    status: String(row[2]),
    visibleHash: String(row[3]),
    visibleRevision: revision,
  };
}

function makeSyncReceipt_(effect, visibleHash, visibleRevision) {
  return {
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    status: "applied",
    visibleHash: visibleHash,
    visibleRevision: visibleRevision,
  };
}

/** Appends one immutable effect identity; a response-loss retry reads it back. */
function writeSyncReceipt_(sheet, receipt) {
  var existing = findSyncReceipt_(sheet, receipt.effectId);
  if (existing !== null) {
    if (!constantTimeEquals_(existing.payloadHash, receipt.payloadHash)) {
      throw new Error("Sync receipt effectId cannot be reused with another payload.");
    }
    return;
  }
  var rowNumber = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(rowNumber, 1, 1, SYNC_RECEIPT_HEADERS_.length).setValues([[
    receipt.effectId,
    receipt.payloadHash,
    receipt.status,
    receipt.visibleHash,
    receipt.visibleRevision,
    new Date().toISOString(),
  ]]);
}

/** HMAC material for typed-sheets-sync-v1; actor/range/key are authenticated too. */
function syncSigningInput_(envelope) {
  return [
    envelope.protocolVersion,
    envelope.requestId,
    envelope.operation,
    envelope.keyId,
    String(envelope.issuedAt),
    String(envelope.expiresAt),
    envelope.sheetId,
    envelope.registeredRange,
    envelope.actorId,
    envelope.bodyHash,
  ].join("\n");
}

/** HMAC material for the trusted projection-provisioning control plane. */
function syncAdminSigningInput_(envelope) {
  return [
    envelope.protocolVersion,
    envelope.requestId,
    envelope.operation,
    envelope.keyId,
    String(envelope.issuedAt),
    String(envelope.expiresAt),
    envelope.sheetId,
    envelope.actorId,
    envelope.bodyHash,
  ].join("\n");
}

function ensureSheetWithHeaders_(spreadsheet, sheetName, expectedHeaders) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);

  var actual = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];
  if (isBlankRow_(actual)) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return sheet;
  }
  for (var index = 0; index < expectedHeaders.length; index += 1) {
    if (actual[index] !== expectedHeaders[index]) {
      throw new Error("Internal sheet " + sheetName + " has unexpected headers and will not be overwritten.");
    }
  }
  return sheet;
}

/**
 * Creates or verifies a gateway-owned tab, then makes it non-user-facing.
 *
 * Hidden tabs are only UI privacy: spreadsheet owners can reveal them. Sheet
 * protection prevents ordinary editors from changing the state, while generic
 * gateway reads reject these names separately below. Failure is explicit so an
 * internal state tab is never silently left exposed after setup.
 */
function ensureInternalSheetWithHeaders_(spreadsheet, sheetName, expectedHeaders) {
  var sheet = ensureSheetWithHeaders_(spreadsheet, sheetName, expectedHeaders);
  protectAndHideInternalSheet_(sheet, sheetName);
  return sheet;
}

/** Applies one stable, non-warning sheet protection and hides the internal tab. */
function protectAndHideInternalSheet_(sheet, sheetName) {
  var description = GATEWAY_INTERNAL_SHEET_PROTECTION_PREFIX_ + sheetName;
  var protection;
  try {
    protection = findInternalSheetProtection_(sheet, description);
    if (protection === null) {
      protection = sheet.protect();
      protection.setDescription(description);
    }
    protection.setWarningOnly(false);
    var editors = protection.getEditors();
    if (editors.length > 0) protection.removeEditors(editors);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  } catch (error) {
    throw new Error(
      "Could not protect internal sheet " + sheetName + ": " + safeErrorMessage_(error),
    );
  }

  try {
    if (!sheet.isSheetHidden()) sheet.hideSheet();
  } catch (error) {
    throw new Error(
      "Could not hide internal sheet " + sheetName + ": " + safeErrorMessage_(error),
    );
  }
}

/** Reuses only this gateway's prior protection to avoid accumulating rules. */
function findInternalSheetProtection_(sheet, description) {
  var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  for (var index = 0; index < protections.length; index += 1) {
    if (protections[index].getDescription() === description) return protections[index];
  }
  return null;
}

function normalizeCellObservation_(rawValue, formula, displayValue, mergeRange) {
  var formulaHash = formula ? sha256Hex_(formula) : null;
  if (mergeRange !== null) {
    return {
      cellKind: "merged",
      normalizedCell: null,
      formulaHash: formulaHash,
      mergeRange: mergeRange,
      errorCode: null,
      stableHash: null,
    };
  }
  if (isDisplayedSheetError_(displayValue)) {
    return {
      cellKind: "error",
      normalizedCell: null,
      formulaHash: formulaHash,
      mergeRange: null,
      errorCode: String(displayValue),
      stableHash: null,
    };
  }
  if (formula) {
    return {
      cellKind: "formula",
      normalizedCell: null,
      formulaHash: formulaHash,
      mergeRange: null,
      errorCode: null,
      stableHash: null,
    };
  }

  var normalized;
  if (rawValue === "") normalized = null;
  else if (isDate_(rawValue)) normalized = { kind: "date", value: rawValue.toISOString() };
  else if (typeof rawValue === "string") normalized = { kind: "string", value: normalizeScalarString_(rawValue) };
  else if (typeof rawValue === "number" && isFinite(rawValue)) normalized = { kind: "number", value: rawValue };
  else if (typeof rawValue === "boolean") normalized = { kind: "boolean", value: rawValue };
  else {
    return {
      cellKind: "error",
      normalizedCell: null,
      formulaHash: null,
      mergeRange: null,
      errorCode: "unsupported_cell_value",
      stableHash: null,
    };
  }

  return {
    cellKind: normalized === null ? "blank" : "literal",
    normalizedCell: normalized,
    formulaHash: null,
    mergeRange: null,
    errorCode: null,
    stableHash: stableHash_(normalized),
  };
}

function mergedCellMap_(range) {
  var merged = {};
  range.getMergedRanges().forEach(function (mergedRange) {
    var a1 = mergedRange.getA1Notation();
    var startRow = mergedRange.getRow();
    var startColumn = mergedRange.getColumn();
    var rows = mergedRange.getNumRows();
    var columns = mergedRange.getNumColumns();
    for (var rowOffset = 0; rowOffset < rows; rowOffset += 1) {
      for (var columnOffset = 0; columnOffset < columns; columnOffset += 1) {
        merged[(startRow + rowOffset) + ":" + (startColumn + columnOffset)] = a1;
      }
    }
  });
  return merged;
}

function validateHeaders_(headerValues) {
  var headers = [];
  var seen = {};
  for (var index = 0; index < headerValues.length; index += 1) {
    var value = headerValues[index];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Snapshot header " + (index + 1) + " is missing or not text.");
    }
    if (seen[value]) throw new Error("Snapshot has duplicate header " + value + ".");
    seen[value] = true;
    headers.push(value);
  }
  return headers;
}

/** Runs the shared stable_encode_v1 golden-vector subset in Apps Script V8. */
function runStableEncodingSelfTest_() {
  var vectors = [
    { id: "null", value: null, sha256: "1b16b1df538ba12dc3f97edbb85caa7050d46c148134290feba80f8236c83db9" },
    { id: "empty-string", value: "", sha256: "fb912574cecad54c6a0bc75b46172350b6374929d602d5fbcb4ca0ec831fd532" },
    { id: "number-one", value: 1, sha256: "e2e59bf702c1a6fc3b58f71b0e8799b321d5cbb99f837b1995c38ae9fd9e339f" },
    { id: "negative-zero-as-zero", value: -0, sha256: "57a94aabf06f605586377a62a3deb150fab0722902f0375f0574f20319a6ba9c" },
    { id: "nfc-korean", value: "가", sha256: "55ff464de596e610f27f00f4acbdba8c8b2549e17dcd062eff568691122186f7" },
    { id: "utc-date", value: { kind: "date", value: "2024-01-01T00:00:00.000Z" }, sha256: "e4211a12a0e8181d9b90bca71424fe416e13cf6d1952e0edf2948dc7c1b696b6" },
    { id: "array-order-preserved", value: [null, true, "x"], sha256: "9bcb97fc9781e1581d1d98e18e26eedcdcffe7ce211dc4bef725c0b2dd20bb1f" },
    { id: "object-keys-utf8-sorted", value: { a: 1, b: 2 }, sha256: "c75706ac88aae728c6245919609250bfa2b5e5ad8f9e5ea1f2f81499cb7a0f70" },
  ];
  var results = vectors.map(function (vector) {
    try {
      var actual = stableHash_(vector.value);
      return { id: vector.id, expected: vector.sha256, actual: actual, passed: actual === vector.sha256 };
    } catch (error) {
      return { id: vector.id, expected: vector.sha256, actual: null, passed: false, error: safeErrorMessage_(error) };
    }
  });
  return {
    runtime: "apps-script-v8",
    normalizeAvailable: typeof "".normalize === "function",
    passed: results.every(function (result) { return result.passed; }),
    vectors: results,
  };
}

function stableHash_(value) {
  return sha256Hex_(stableEncode_(value));
}

function stableEncode_(value) {
  if (value === null) return "n";
  if (value === true) return "b1";
  if (value === false) return "b0";
  if (typeof value === "number") return stableEncodeNumber_(value);
  if (typeof value === "string") return stableEncodeString_(value);
  if (isDateValue_(value)) return stableEncodeDate_(value.value);
  if (Array.isArray(value)) {
    return "a" + value.length + "[" + value.map(function (entry) { return stableEncode_(entry); }).join("") + "]";
  }
  if (isPlainObject_(value)) return stableEncodeObject_(value);
  throw new Error("stable_encode: unsupported value type");
}

function stableEncodeNumber_(value) {
  if (!isFinite(value)) throw new Error("stable_encode: non-finite number");
  var decimal = value === 0 ? "0" : String(value).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
  return "f" + utf8ByteLength_(decimal) + ":" + decimal;
}

function stableEncodeString_(value) {
  var nfc = normalizeScalarString_(value);
  return "s" + utf8ByteLength_(nfc) + ":" + nfc;
}

function stableEncodeDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new Error("stable_encode: invalid date format");
  }
  if (utf8ByteLength_(value) !== 24) throw new Error("stable_encode: date must be 24 bytes");
  return "d24:" + value;
}

function stableEncodeObject_(value) {
  var entries = [];
  var normalizedKeys = [];
  Object.keys(value).forEach(function (key) {
    var nfcKey = normalizeScalarString_(key);
    if (normalizedKeys.indexOf(nfcKey) >= 0) {
      throw new Error("stable_encode: duplicate object key after NFC normalization");
    }
    normalizedKeys.push(nfcKey);
    entries.push({ key: nfcKey, bytes: utf8Bytes_(nfcKey), value: value[key] });
  });
  entries.sort(function (left, right) { return compareUnsignedBytes_(left.bytes, right.bytes); });
  return "o" + entries.length + "{" + entries.map(function (entry) {
    return "s" + entry.bytes.length + ":" + entry.key + stableEncode_(entry.value);
  }).join("") + "}";
}

function isDateValue_(value) {
  return isPlainObject_(value) &&
    Object.keys(value).length === 2 &&
    value.kind === "date" &&
    typeof value.value === "string";
}

function normalizeScalarString_(value) {
  for (var index = 0; index < value.length; index += 1) {
    var codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      var next = value.charCodeAt(index + 1);
      if (!isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("stable_encode: string contains an unpaired high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("stable_encode: string contains an unpaired low surrogate");
    }
  }
  if (typeof value.normalize !== "function") {
    throw new Error("stable_encode: Apps Script runtime lacks String.normalize");
  }
  return value.normalize("NFC");
}

function canonicalJson_(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error("Sync payload numbers must be finite");
    return (value === 0 ? "0" : String(value)).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
  }
  if (Array.isArray(value)) {
    return "[" + value.map(function (entry) { return canonicalJson_(entry); }).join(",") + "]";
  }
  if (isPlainObject_(value)) {
    return "{" + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ":" + canonicalJson_(value[key]);
    }).join(",") + "}";
  }
  throw new Error("Sync payload has unsupported value type");
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) {
      var unsigned = byte < 0 ? byte + 256 : byte;
      return ("0" + unsigned.toString(16)).slice(-2);
    })
    .join("");
}

function hmacSha256Base64Url_(value, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret)).replace(/=+$/, "");
}

function utf8Bytes_(value) {
  return Utilities.newBlob(value).getBytes();
}

function utf8ByteLength_(value) {
  return utf8Bytes_(value).length;
}

function compareUnsignedBytes_(left, right) {
  var count = Math.min(left.length, right.length);
  for (var index = 0; index < count; index += 1) {
    var leftByte = left[index] < 0 ? left[index] + 256 : left[index];
    var rightByte = right[index] < 0 ? right[index] + 256 : right[index];
    if (leftByte < rightByte) return -1;
    if (leftByte > rightByte) return 1;
  }
  return left.length - right.length;
}

function constantTimeEquals_(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  var maxLength = Math.max(left.length, right.length);
  var difference = left.length ^ right.length;
  for (var index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isPlainObject_(value) {
  return value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime());
}

function isDisplayedSheetError_(value) {
  return typeof value === "string" && /^#(REF!|DIV\/0!|N\/A|VALUE!|NAME\?|NUM!|ERROR!|NULL!)$/.test(value);
}

function isBlankRow_(row) {
  return row.every(function (cell) { return cell === "" || cell === null; });
}

function requireObjectField_(object, key) {
  if (!isPlainObject_(object) || !Object.prototype.hasOwnProperty.call(object, key)) {
    throw new Error("Missing required payload field " + key + ".");
  }
  return object[key];
}

function requireSafeString_(value, fieldName) {
  if (!isNonEmptyString_(value) || value.length > 1024) {
    throw new Error(fieldName + " must be a non-empty string of at most 1024 characters.");
  }
  return value;
}

function isNonEmptyString_(value) {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger_(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isPositiveOrZeroInteger_(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function success_(result) {
  return { ok: true, result: result };
}

function failure_(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function safeErrorMessage_(error) {
  var message = error && error.message ? String(error.message) : "Unexpected gateway failure.";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
