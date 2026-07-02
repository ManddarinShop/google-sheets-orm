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
  const { cwd, prompt } = options;

  await prompt.showMessage(createSetupWelcomeMessage());

  const authType = await prompt.selectAuthType();

  let config: TypedSheetsConfig;

  if (authType === "apps-script-gateway") {
    const inputAppsScriptGatewayConfig =
      prompt.inputAppsScriptGatewayConfig;

    if (inputAppsScriptGatewayConfig === undefined) {
      throw new Error(
        "inputAppsScriptGatewayConfig is required for apps-script-gateway auth",
      );
    }

    await prompt.showMessage(createManualAppsScriptGatewayIntro());

    const selectAppsScriptCodePrintMode =
      prompt.selectAppsScriptCodePrintMode;

    const codePrintMode =
      selectAppsScriptCodePrintMode === undefined
        ? undefined
        : await selectAppsScriptCodePrintMode();

    if (codePrintMode === "sheet-info") {
      await prompt.showMessage(createManualAppsScriptSheetInfoCodeMessage());
    }

    if (codePrintMode === "gateway") {
      await prompt.showMessage(createManualAppsScriptGatewayCodeMessage());
    }

    const rawGatewayConfig = await inputAppsScriptGatewayConfig();

    const parsedGatewayConfig =
      requireAppsScriptGatewayConfigJson(rawGatewayConfig);

    config = parseTypedSheetsConfig(parsedGatewayConfig);
  } else {
    const inputServiceAccountCredentialsFile =
      prompt.inputServiceAccountCredentialsFile;

    if (inputServiceAccountCredentialsFile === undefined) {
      throw new Error(
        "inputServiceAccountCredentialsFile is required for service-account auth",
      );
    }

    await prompt.showMessage(createServiceAccountInstructions());

    const spreadsheetUrl = await prompt.inputSpreadsheetUrl();
    const defaultSheetName = await prompt.inputDefaultSheetName();
    const credentialsFile = await inputServiceAccountCredentialsFile();

    config = {
      spreadsheetUrl,
      defaultSheetName,
      auth: {
        type: "service-account",
        credentialsFile,
      },
    };
  }

  const configPath = await prompt.inputConfigPath();

  await writeTypedSheetsConfig({
    configPath: join(cwd ?? process.cwd(), configPath),
    config,
  });

  await prompt.showMessage(`Created ${configPath}`);
}

function requireAppsScriptGatewayConfigJson(rawGatewayConfig: string): unknown {
  try {
    return JSON.parse(rawGatewayConfig);
  } catch {
    throw new Error("Apps Script gateway config must be valid JSON");
  }
}
