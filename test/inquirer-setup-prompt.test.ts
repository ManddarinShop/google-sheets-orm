import { describe, expect, it, vi } from "vitest";

import { createInquirerSetupPrompt } from "../src/setup/InquirerSetupPrompt.js";

describe("inquirer setup prompt adapter", () => {
  it("maps the auth type prompt to an Apps Script gateway selection", async () => {
    const select = vi.fn().mockResolvedValue("apps-script-gateway");
    const input = vi.fn();

    const prompt = createInquirerSetupPrompt({ select, input });

    await expect(prompt.selectAuthType()).resolves.toBe("apps-script-gateway");
    expect(select).toHaveBeenCalledWith({
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
    });
  });

  it("writes setup instructions to the configured output", async () => {
    const select = vi.fn();
    const input = vi.fn();
    const output = {
      write: vi.fn(),
    };

    const prompt = createInquirerSetupPrompt({ select, input, output });

    await expect(prompt.showMessage("setup instructions")).resolves.toBeUndefined();
    expect(output.write).toHaveBeenCalledWith("setup instructions\n");
  });

  it("maps spreadsheet, sheet, gateway config, and config path questions to input prompts", async () => {
    const select = vi.fn();
    const input = vi
      .fn()
      .mockResolvedValueOnce("https://docs.google.com/spreadsheets/d/spreadsheet-id/edit")
      .mockResolvedValueOnce("Users")
      .mockResolvedValueOnce('{"auth":{"type":"apps-script-gateway"}}')
      .mockResolvedValueOnce(".typed-sheets.json");

    const prompt = createInquirerSetupPrompt({ select, input });

    await expect(prompt.inputSpreadsheetUrl()).resolves.toBe(
      "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
    );
    await expect(prompt.inputDefaultSheetName()).resolves.toBe("Users");
    await expect(prompt.inputAppsScriptGatewayConfig?.()).resolves.toBe(
      '{"auth":{"type":"apps-script-gateway"}}',
    );
    await expect(prompt.inputConfigPath()).resolves.toBe(".typed-sheets.json");

    expect(input).toHaveBeenNthCalledWith(1, {
      message: "Google Sheet URL",
    });
    expect(input).toHaveBeenNthCalledWith(2, {
      message: "Default sheet tab",
      default: "Users",
    });
    expect(input).toHaveBeenNthCalledWith(3, {
      message: "Paste the generated config JSON from Apps Script logs",
    });
    expect(input).toHaveBeenNthCalledWith(4, {
      message: "Config file path",
      default: ".typed-sheets.json",
    });
  });

  it("maps service account credentials to an input prompt", async () => {
    const select = vi.fn();
    const input = vi.fn().mockResolvedValue("/absolute/path/to/service-account.json");

    const prompt = createInquirerSetupPrompt({ select, input });

    await expect(prompt.inputServiceAccountCredentialsFile?.()).resolves.toBe(
      "/absolute/path/to/service-account.json",
    );
    expect(input).toHaveBeenCalledWith({
      message: "Service account JSON key path",
    });
  });

  it("maps the Apps Script snippet print question to a select prompt", async () => {
    const select = vi.fn().mockResolvedValue("sheet-info");
    const input = vi.fn();

    const prompt = createInquirerSetupPrompt({ select, input });

    await expect(prompt.selectAppsScriptCodePrintMode?.()).resolves.toBe(
      "sheet-info",
    );
    expect(select).toHaveBeenCalledWith({
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
    });
  });
});
