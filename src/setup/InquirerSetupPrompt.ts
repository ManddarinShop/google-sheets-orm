import {
  input as inquirerInput,
  select as inquirerSelect,
} from "@inquirer/prompts";
import type { SetupPrompt } from "./Setup.js";


type AuthType = "oauth" | "service-account";

type SelectPrompt = typeof inquirerSelect;
type InputPrompt = typeof inquirerInput;

export interface InquirerSetupPromptDependencies { 
    select?: SelectPrompt;
    input?: InputPrompt;
}

export function createInquirerSetupPrompt(dependencies: InquirerSetupPromptDependencies = {}): SetupPrompt { 
    const select = dependencies.select ?? inquirerSelect;
    const input = dependencies.input ?? inquirerInput;

    return {
      async selectAuthType(): Promise<AuthType> {
        return select({
          message: "How do you want to authenticate?",
          choices: [
            { name: "Google login", value: "oauth" },
            { name: "Service account", value: "service-account" },
          ],
        }) as Promise<AuthType>;
      },

      async inputSpreadsheetUrl(): Promise<string> {
        return input({
          message: "Google Sheets URL:",
        });
      },

      async inputDefaultSheetName(): Promise<string> {
        return input({
          message: "Default sheet name:",
          default: "Users",
        });
      },

      async inputServiceAccountCredentialsFile(): Promise<string> {
        return input({
          message: "Service account JSON file path:",
        });
      },

      async inputConfigPath(): Promise<string> {
        return input({
          message: "Config file path:",
          default: ".typed-sheets.json",
        });
      },

      async inputOAuthTokenFile(): Promise<string> {
        return input({
          message: "OAuth token file path:",
          default: ".typed-sheets/token.json",
        });
      },
    };
}