import { join } from "node:path";
import { writeTypedSheetsConfig } from "./ConfigWriter.js";
import { parseTypedSheetsConfig, type TypedSheetsConfig } from "./Config.js";
import {
  createManualAppsScriptGatewayCodeMessage,
  createManualAppsScriptGatewayIntro,
  createManualAppsScriptSheetInfoCodeMessage,
  createServiceAccountInstructions,
  createSetupWelcomeMessage,
  type SetupPlatform,
} from "./ManualAppsScriptGateway.js";

export type SetupAuthType = "apps-script-gateway" | "service-account";
export type AppsScriptCodePrintMode =
  | "none"
  | "sheet-info"
  | "gateway";

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
  platform?: SetupPlatform;
  prompt: SetupPrompt;
}): Promise<void> {
  const { cwd, prompt } = options;
  const platform = options.platform ?? process.platform;

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

    await prompt.showMessage(createManualAppsScriptGatewayIntro(platform));

    const selectAppsScriptCodePrintMode =
      prompt.selectAppsScriptCodePrintMode;

    const codePrintMode =
      selectAppsScriptCodePrintMode === undefined
        ? "none"
        : await selectAppsScriptCodePrintMode();

    if (codePrintMode === "sheet-info") {
      await prompt.showMessage(createManualAppsScriptSheetInfoCodeMessage(platform));
    } else if (codePrintMode === "gateway") {
      await prompt.showMessage(createManualAppsScriptGatewayCodeMessage(platform));
    }

    const rawGatewayConfig = await inputAppsScriptGatewayConfig();

    const parsedGatewayConfig =
      parseAppsScriptGatewayConfigInput(rawGatewayConfig);

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

export function parseAppsScriptGatewayConfigInput(input: string): unknown {
  const jsonObject = requireFirstJsonObject(input);

  try {
    return JSON.parse(jsonObject);
  } catch {
    throw new Error("Apps Script gateway config must contain valid JSON");
  }
}

function requireFirstJsonObject(input: string): string {
  const jsonObject = extractFirstJsonObjectOrNull(input);

  if (jsonObject === null) {
    throw new Error("Apps Script gateway config must contain valid JSON");
  }

  return jsonObject;
}

function extractFirstJsonObjectOrNull(input: string): string | null {
  const start = input.indexOf("{");

  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  return null;
}
