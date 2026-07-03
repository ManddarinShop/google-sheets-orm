export const manualAppsScriptGatewayCodePath =
  "templates/manual-apps-script-gateway/Code.gs";

export const manualAppsScriptSheetInfoCodePath =
  "templates/manual-apps-script-gateway/SheetInfo.gs";

export type SetupPlatform = NodeJS.Platform;

export function createSetupWelcomeMessage(): string {
  return [
    "typed-sheets setup",
    "",
    "This command creates a local .typed-sheets.json file.",
    "To connect typed-sheets to your Google Sheet, choose a setup path and copy the matching Apps Script file when prompted.",
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

export function createManualAppsScriptGatewayIntro(
  platform: SetupPlatform = process.platform,
): string {
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
    "   - Copy command:",
    `     ${createClipboardCopyCommand(manualAppsScriptGatewayCodePath, platform)}`,
    "",
    "For this Apps Script gateway setup, use the gateway script.",
    "",
    "Gateway steps:",
    "1. Open the target Google Sheet.",
    "2. Go to Extensions > Apps Script.",
    "3. Copy the gateway script from the file path above, then paste it into Code.gs.",
    "4. Deploy > New deployment > Web app.",
    "5. Set Execute as to Me.",
    "6. Set Who has access to Anyone.",
    "7. Run setupTypedSheets() or reload the sheet and click typed-sheets > Setup gateway.",
    "8. Open Apps Script execution logs and copy the generated JSON.",
    "9. Paste that JSON into the next prompt.",
  ].join("\n");
}

export function createManualAppsScriptSheetInfoCodeMessage(
  platform: SetupPlatform = process.platform,
): string {
  return [
    `SheetInfo.gs (${manualAppsScriptSheetInfoCodePath})`,
    "",
    "Copy this file into Apps Script Code.gs, then run setupTypedSheetsSheetInfo().",
    "Deployment is not needed.",
    "",
    "Copy command:",
    createClipboardCopyCommand(manualAppsScriptSheetInfoCodePath, platform),
  ].join("\n");
}

export function createManualAppsScriptGatewayCodeMessage(
  platform: SetupPlatform = process.platform,
): string {
  return [
    `Code.gs (${manualAppsScriptGatewayCodePath})`,
    "",
    "Copy this file into Apps Script Code.gs, then deploy it as a Web App.",
    "",
    "Copy command:",
    createClipboardCopyCommand(manualAppsScriptGatewayCodePath, platform),
  ].join("\n");
}

export function createClipboardCopyCommand(
  filePath: string,
  platform: SetupPlatform = process.platform,
): string {
  if (platform === "darwin") {
    return `pbcopy < ${filePath}`;
  }

  if (platform === "win32") {
    return `Get-Content ${filePath} | Set-Clipboard`;
  }

  return `xclip -selection clipboard < ${filePath}`;
}
