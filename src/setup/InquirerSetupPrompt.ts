import {
  editor as inquirerEditor,
  input as inquirerInput,
  select as inquirerSelect,
} from "@inquirer/prompts";
import type {
  AppsScriptCodePrintMode,
  SetupAuthType,
  SetupPrompt,
} from "./Setup.js";

type SelectPrompt = typeof inquirerSelect;
type InputPrompt = typeof inquirerInput;
type EditorPrompt = typeof inquirerEditor;

export interface InquirerSetupPromptDependencies {
  select?: SelectPrompt;
  input?: InputPrompt;
  editor?: EditorPrompt;
  output?: Pick<NodeJS.WriteStream, "write">;
}

export function createInquirerSetupPrompt(
  dependencies: InquirerSetupPromptDependencies = {},
): SetupPrompt {
  const select = dependencies.select ?? inquirerSelect;
  const input = dependencies.input ?? inquirerInput;
  const editor = dependencies.editor ?? inquirerEditor;
  const output = dependencies.output ?? process.stdout;

  return {
    async selectAuthType(): Promise<SetupAuthType> {
      return select({
        message: "How should typed-sheets connect?",
        choices: [
          {
            name: "Service account - server or CI",
            value: "service-account",
          },
          {
            name: "Manual Apps Script gateway - no Google Cloud OAuth",
            value: "apps-script-gateway",
          },
        ],
      }) as Promise<SetupAuthType>;
    },

    async showMessage(message: string): Promise<void> {
      output.write(`${message}\n`);
    },

    async inputSpreadsheetUrl(): Promise<string> {
      return input({
        message: "Google Sheet URL",
      });
    },

    async inputDefaultSheetName(): Promise<string> {
      return input({
        message: "Default sheet tab",
        default: "Users",
      });
    },

    async inputServiceAccountCredentialsFile(): Promise<string> {
      return input({
        message: "Service account JSON key path",
      });
    },

    async selectAppsScriptCodePrintMode(): Promise<AppsScriptCodePrintMode> {
      return select({
        message: "Print an Apps Script snippet now?",
        choices: [
          { name: "No, I will open the reference file", value: "none" },
          {
            name: "Small sheet info helper - run only",
            value: "sheet-info",
          },
          {
            name: "Full gateway script - deploy as Web App",
            value: "gateway",
          },
        ],
      }) as Promise<AppsScriptCodePrintMode>;
    },

    async inputAppsScriptGatewayConfig(): Promise<string> {
      return editor({
        message: "Paste the generated config JSON or Apps Script log output",
      });
    },

    async inputConfigPath(): Promise<string> {
      return input({
        message: "Config file path",
        default: ".typed-sheets.json",
      });
    },
  };
}
