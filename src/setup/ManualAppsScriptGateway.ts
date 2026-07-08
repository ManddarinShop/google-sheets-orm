export const manualAppsScriptGatewayCodePath =
  "templates/manual-apps-script-gateway/Code.gs";

export const manualAppsScriptSheetInfoCodePath =
  "templates/manual-apps-script-gateway/SheetInfo.gs";

export type SetupPlatform = NodeJS.Platform;

export function createSetupWelcomeMessage(): string {
  return [
    "typed-sheets setup",
    "",
    "This will create a local .typed-sheets.json file for your app.",
    "Choose how this app should connect to your Google Sheet.",
  ].join("\n");
}

export function createServiceAccountInstructions(): string {
  return [
    "Service account setup",
    "",
    "Use this when your app runs on a server, CI job, or deployed backend.",
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
    "Use this when the spreadsheet owner will install a small Apps Script gateway.",
    "The gateway lets typed-sheets call your Sheet without setting up Google Cloud OAuth.",
    "",
    "Files you may copy into Apps Script:",
    "",
    `1. Sheet info helper: ${manualAppsScriptSheetInfoCodePath}`,
    "   - Optional helper for checking the Sheet URL and default tab.",
    "   - Run it only if you need those values.",
    "   - No Web App deployment is needed.",
    "",
    `2. Gateway script: ${manualAppsScriptGatewayCodePath}`,
    "   - Main script for the Apps Script gateway path.",
    "   - Copy this into Apps Script, deploy it as a Web App, then run setup.",
    "   - Copy command:",
    `     ${createClipboardCopyCommand(manualAppsScriptGatewayCodePath, platform)}`,
    "",
    "For this setup, use the gateway script.",
    "",
    "Gateway steps:",
    "1. Open the target Google Sheet.",
    "2. Go to Extensions > Apps Script.",
    "3. Copy the gateway script from the file path above, then paste it into Code.gs.",
    "4. Deploy > New deployment > Web app.",
    "5. Set Execute as to Me.",
    "6. Set Who has access to Anyone.",
    "7. Copy the Web App URL shown after deployment. It must end with /exec.",
    "8. Paste that URL into TYPED_SHEETS_GATEWAY_URL near the top of Code.gs.",
    "9. Run setupTypedSheets() from the Apps Script editor.",
    "10. Open Apps Script execution logs and copy the generated JSON.",
    "11. Paste that JSON into the next prompt.",
  ].join("\n");
}

export function createManualAppsScriptSheetInfoCodeMessage(
  platform: SetupPlatform = process.platform,
): string {
  return [
    `SheetInfo.gs (${manualAppsScriptSheetInfoCodePath})`,
    "",
    "Copy this helper into Apps Script only if you want to inspect the Sheet URL and default tab.",
    "Run setupTypedSheetsSheetInfo(). You do not need to deploy it.",
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
    "Copy this gateway into Apps Script Code.gs, then deploy it as a Web App.",
    "After deployment, paste the Web App /exec URL into TYPED_SHEETS_GATEWAY_URL, run setupTypedSheets(), and copy the generated JSON from execution logs.",
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
