export const manualAppsScriptGatewayCodePath =
  "templates/manual-apps-script-gateway/Code.gs";

export const manualAppsScriptSheetInfoCodePath =
  "templates/manual-apps-script-gateway/SheetInfo.gs";

export const manualAppsScriptSheetInfoCode = `function setupTypedSheetsSheetInfo() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = spreadsheet.getActiveSheet();

  const info = {
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    defaultSheetName: activeSheet.getName(),
  };

  Logger.log(JSON.stringify(info, null, 2));

  return info;
}`;

export const manualAppsScriptGatewayCode = `const TYPED_SHEETS_CONFIG_PROPERTY = "typedSheetsConfig";
const TYPED_SHEETS_META_SHEET_NAME = "_typed_sheets_meta";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("typed-sheets")
    .addItem("Setup gateway", "setupTypedSheets")
    .addToUi();
}

function setupTypedSheets() {
  const config = createTypedSheetsConfig_();
  const configJson = JSON.stringify(config, null, 2);

  Logger.log(configJson);
  SpreadsheetApp.getUi().alert(
    "typed-sheets config was generated. Open Apps Script execution logs and copy the JSON into .typed-sheets.json.",
  );

  return config;
}

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

      if (operation === "updateRow") {
        updateRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRow") {
        deleteRow_(spreadsheet, request);
        return json_({ ok: true });
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
    "writeHeader",
    "readSheet",
    "appendRow",
    "updateRow",
    "deleteRow",
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

  if (operation === "appendRow") {
    requireSheetCellArray_(request.row, "row");
  }

  if (operation === "updateRow") {
    requirePositiveInteger_(request.rowNumber, "rowNumber");
    requireSheetCellArray_(request.row, "row");
  }

  if (operation === "deleteRow") {
    requirePositiveInteger_(request.rowNumber, "rowNumber");
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

function updateRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const row = requireSheetCellArray_(request.row, "row");
  const rowNumber = requirePositiveInteger_(request.rowNumber, "rowNumber");

  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
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

function requirePositiveInteger_(value, name) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw gatewayError_("invalid_request", name + " must be a positive integer");
  }

  return numberValue;
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
    const gatewaySecret = existing && existing.auth.gatewaySecret
      ? existing.auth.gatewaySecret
      : Utilities.getUuid();
    const gatewayUrl = getGatewayUrlOrEmpty_();

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
  const sheet = spreadsheet.getSheetByName(TYPED_SHEETS_META_SHEET_NAME)
    || spreadsheet.insertSheet(TYPED_SHEETS_META_SHEET_NAME);

  sheet.clear();
  sheet.hideSheet();
  sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  sheet.getRange(2, 1, 5, 2).setValues([
    ["spreadsheetUrl", config.spreadsheetUrl],
    ["defaultSheetName", config.defaultSheetName],
    ["gatewayUrl", config.auth.gatewayUrl],
    ["authType", config.auth.type],
    ["connectedAt", new Date().toISOString()],
  ]);
}

function getGatewayUrlOrEmpty_() {
  try {
    return ScriptApp.getService().getUrl() || "";
  } catch (error) {
    return "";
  }
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
`;

export function createSetupWelcomeMessage(): string {
  return [
    "typed-sheets setup",
    "",
    "This command creates a local .typed-sheets.json file.",
    "Choose the connection path that matches how this app will run.",
  ].join("\n");
}

export function createServiceAccountInstructions(): string {
  return [
    "Service account setup",
    "",
    "Use this for a server, CI job, or deployed app.",
    "",
    "Before continuing:",
    "1. Create or choose a Google service account.",
    "2. Download its JSON key file.",
    "3. Share the target Google Sheet with the service account client_email.",
    "",
    "typed-sheets will use the JSON key to call the Google Sheets API directly.",
  ].join("\n");
}

export function createManualAppsScriptGatewayIntro(): string {
  return [
    "Manual Apps Script gateway setup",
    "",
    "Use this when you want to avoid Google Cloud OAuth setup.",
    "",
    "There are two Apps Script snippets:",
    "",
    `1. Sheet info helper: ${manualAppsScriptSheetInfoCodePath}`,
    "   - Small copy-paste script.",
    "   - Run only. No Web App deployment.",
    "   - Prints spreadsheetId, spreadsheetUrl, and defaultSheetName.",
    "",
    `2. Gateway script: ${manualAppsScriptGatewayCodePath}`,
    "   - Full copy-paste script.",
    "   - Requires Web App deployment.",
    "   - Prints the config JSON that this setup prompt needs.",
    "",
    "For this Apps Script gateway setup, use the gateway script.",
    "",
    "Gateway steps:",
    "1. Open the target Google Sheet.",
    "2. Go to Extensions > Apps Script.",
    "3. Paste the gateway Code.gs script.",
    "4. Deploy > New deployment > Web app.",
    "5. Set Execute as to Me.",
    "6. Set Who has access to Anyone.",
    "7. Run setupTypedSheets().",
    "8. Open Apps Script execution logs and copy the generated JSON.",
    "9. Paste that JSON into the next prompt.",
  ].join("\n");
}

export function createManualAppsScriptSheetInfoCodeMessage(): string {
  return [
    `SheetInfo.gs (${manualAppsScriptSheetInfoCodePath})`,
    "",
    "Run setupTypedSheetsSheetInfo() in Apps Script. Deployment is not needed.",
    "",
    "```js",
    manualAppsScriptSheetInfoCode,
    "```",
  ].join("\n");
}

export function createManualAppsScriptGatewayCodeMessage(): string {
  return [
    `Code.gs (${manualAppsScriptGatewayCodePath})`,
    "",
    "```js",
    manualAppsScriptGatewayCode,
    "```",
  ].join("\n");
}
