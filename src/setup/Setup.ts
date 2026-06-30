import { join } from "node:path";
import { writeTypedSheetsConfig } from "./ConfigWriter.js";
import type { TypedSheetsConfig } from "./Config.js";

export interface SetupPrompt {
  selectAuthType(): Promise<"oauth" | "service-account">;
  inputSpreadsheetUrl(): Promise<string>;
  inputDefaultSheetName(): Promise<string>;
  inputServiceAccountCredentialsFile?(): Promise<string>;
  inputConfigPath(): Promise<string>;
  inputOAuthTokenFile(): Promise<string>;
}

export async function runSetup(options: {
  cwd?: string;
  prompt: SetupPrompt;
}): Promise<void> {
  const authType = await options.prompt.selectAuthType();
  const spreadsheetUrl = await options.prompt.inputSpreadsheetUrl();
  const defaultSheetName = await options.prompt.inputDefaultSheetName();

  let config: TypedSheetsConfig;

  if (authType === "service-account") {
    if (!options.prompt.inputServiceAccountCredentialsFile) {
      throw new Error(
        "inputServiceAccountCredentialsFile is required for service-account auth",
      );
    }

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
  } else {
    if (!options.prompt.inputOAuthTokenFile) {
      throw new Error("inputOAuthTokenFile is required for oauth auth");
    }

    const tokenFile = await options.prompt.inputOAuthTokenFile();

    config = {
      spreadsheetUrl,
      defaultSheetName,
      auth: {
        type: "oauth",
        tokenFile
      },
    };
  }

  const configPath = await options.prompt.inputConfigPath();

  await writeTypedSheetsConfig({
    configPath: join(options.cwd ?? process.cwd(), configPath),
    config,
  });
}
