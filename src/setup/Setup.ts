import { join } from "node:path";
import { writeTypedSheetsConfig } from "./ConfigWriter.js";
import { parseTypedSheetsConfig, type TypedSheetsConfig } from "./Config.js";
import {
  createManualAppsScriptGatewayCodeMessage,
  createManualAppsScriptGatewayIntro,
  createManualAppsScriptSheetInfoCodeMessage,
  createServiceAccountInstructions,
  createSetupWelcomeMessage,
} from "./ManualAppsScriptGateway.js";

export type SetupAuthType = "apps-script-gateway" | "service-account";
export type AppsScriptCodePrintMode = "none" | "sheet-info" | "gateway";

export interface SetupPrompt {
  selectAuthType(): Promise<SetupAuthType>;
  showMessage(message: string): Promise<void>;
  selectAppsScriptCodePrintMode?(): Promise<AppsScriptCodePrintMode>;
  inputSpreadsheetUrl(): Promise<string>;
  inputDefaultSheetName(): Promise<string>;
  inputAppsScriptGatewayConfig?(): Promise<string>;
  inputServiceAccountCredentialsFile?(): Promise<string>;
  inputConfigPath(): Promise<string>;
}

export async function runSetup(options: {
  cwd?: string;
  prompt: SetupPrompt;
}): Promise<void> {
  await options.prompt.showMessage(createSetupWelcomeMessage());

  const authType = await options.prompt.selectAuthType();

  let config: TypedSheetsConfig;

  if (authType === "apps-script-gateway") {
    if (!options.prompt.inputAppsScriptGatewayConfig) {
      throw new Error(
        "inputAppsScriptGatewayConfig is required for apps-script-gateway auth",
      );
    }

    await options.prompt.showMessage(createManualAppsScriptGatewayIntro());

    const codePrintMode =
      options.prompt.selectAppsScriptCodePrintMode &&
      (await options.prompt.selectAppsScriptCodePrintMode());

    if (codePrintMode === "sheet-info") {
      await options.prompt.showMessage(createManualAppsScriptSheetInfoCodeMessage());
    }

    if (codePrintMode === "gateway") {
      await options.prompt.showMessage(createManualAppsScriptGatewayCodeMessage());
    }

    const rawGatewayConfig =
      await options.prompt.inputAppsScriptGatewayConfig();

    let parsedGatewayConfig: unknown;

    try {
      parsedGatewayConfig = JSON.parse(rawGatewayConfig);
    } catch {
      throw new Error("Apps Script gateway config must be valid JSON");
    }

    config = parseTypedSheetsConfig(parsedGatewayConfig);
  } else {
    if (!options.prompt.inputServiceAccountCredentialsFile) {
      throw new Error(
        "inputServiceAccountCredentialsFile is required for service-account auth",
      );
    }

    await options.prompt.showMessage(createServiceAccountInstructions());

    const spreadsheetUrl = await options.prompt.inputSpreadsheetUrl();
    const defaultSheetName = await options.prompt.inputDefaultSheetName();
    const credentialsFile =
      await options.prompt.inputServiceAccountCredentialsFile();

    config = {
      spreadsheetUrl,
      defaultSheetName,
      auth: {
        type: "service-account",
        credentialsFile,
      },
    };
  }

  const configPath = await options.prompt.inputConfigPath();

  await writeTypedSheetsConfig({
    configPath: join(options.cwd ?? process.cwd(), configPath),
    config,
  });

  await options.prompt.showMessage(`Created ${configPath}`);
}
