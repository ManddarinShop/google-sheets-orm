export const manualAppsScriptGatewayCodePath =
  "spikes/manual-apps-script-gateway/Code.gs";

export const manualAppsScriptSheetInfoCodePath =
  "spikes/manual-apps-script-gateway/SheetInfo.gs";

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
}`;

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
