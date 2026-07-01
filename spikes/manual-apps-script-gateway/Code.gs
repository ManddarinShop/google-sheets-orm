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

  if (request.operation !== "ping") {
    return json_({
      ok: false,
      error: "unknown_operation",
    });
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    return json_({
      ok: true,
      locked: true,
      spreadsheetId: spreadsheet.getId(),
      sheetName: spreadsheet.getActiveSheet().getName(),
    });
  } finally {
    lock.releaseLock();
  }
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
