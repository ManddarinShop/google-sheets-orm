const TYPED_SHEETS_CONFIG_PROPERTY = "typedSheetsConfig";
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
  const request = JSON.parse((e.postData && e.postData.contents) || "{}");
  const config = getTypedSheetsConfig_();

  if (!config || request.secret !== config.auth.gatewaySecret) {
    return json_({
      ok: false,
      error: "unauthorized",
    });
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    if (request.operation === "ping") {
      return json_({
        ok: true,
        locked: true,
        spreadsheetId: spreadsheet.getId(),
        sheetName: spreadsheet.getActiveSheet().getName(),
      });
    }

    if (request.operation === "readSheet") {
      return json_(readSheet_(spreadsheet, request));
    }

    if (request.operation === "appendRow") {
      appendRow_(spreadsheet, request);
      return json_({ ok: true });
    }

    if (request.operation === "updateRow") {
      updateRow_(spreadsheet, request);
      return json_({ ok: true });
    }

    return json_({
      ok: false,
      error: "unknown_operation",
    });
  } catch (error) {
    return json_({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  } finally {
    lock.releaseLock();
  }
}

function readSheet_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
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
  const row = requireArray_(request.row, "row");

  sheet.appendRow(row);
}

function updateRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const row = requireArray_(request.row, "row");
  const rowNumber = Number(request.rowNumber);

  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("rowNumber must be a positive integer");
  }

  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
}

function getSheet_(spreadsheet, sheetName) {
  if (typeof sheetName !== "string" || sheetName.trim() === "") {
    throw new Error("sheetName must be a non-empty string");
  }

  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error("sheet not found: " + sheetName);
  }

  return sheet;
}

function requireArray_(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(name + " must be an array");
  }

  return value;
}

function toSheetCell_(value) {
  if (value === "") {
    return null;
  }

  return value;
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
