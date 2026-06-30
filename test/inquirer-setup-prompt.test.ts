import { describe, expect, it, vi } from "vitest";

import { createInquirerSetupPrompt } from "../src/setup/InquirerSetupPrompt.js";

describe("inquirer setup prompt adapter", () => {
  it("maps the auth type prompt to an OAuth selection", async () => {
    const select = vi.fn().mockResolvedValue("oauth");
    const input = vi.fn();

    const prompt = createInquirerSetupPrompt({ select, input });

    await expect(prompt.selectAuthType()).resolves.toBe("oauth");
    expect(select).toHaveBeenCalledWith({
      message: "How do you want to authenticate?",
      choices: [
        { name: "Google login", value: "oauth" },
        { name: "Service account", value: "service-account" },
      ],
    });
  });

  it("maps spreadsheet, sheet, OAuth token, and config path questions to input prompts", async () => {
    const select = vi.fn();
    const input = vi
      .fn()
      .mockResolvedValueOnce("https://docs.google.com/spreadsheets/d/spreadsheet-id/edit")
      .mockResolvedValueOnce("Users")
      .mockResolvedValueOnce(".typed-sheets/token.json")
      .mockResolvedValueOnce(".typed-sheets.json");

    const prompt = createInquirerSetupPrompt({ select, input });

    await expect(prompt.inputSpreadsheetUrl()).resolves.toBe(
      "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
    );
    await expect(prompt.inputDefaultSheetName()).resolves.toBe("Users");
    await expect(prompt.inputOAuthTokenFile?.()).resolves.toBe(
      ".typed-sheets/token.json",
    );
    await expect(prompt.inputConfigPath()).resolves.toBe(".typed-sheets.json");

    expect(input).toHaveBeenNthCalledWith(1, {
      message: "Google Sheets URL:",
    });
    expect(input).toHaveBeenNthCalledWith(2, {
      message: "Default sheet name:",
      default: "Users",
    });
    expect(input).toHaveBeenNthCalledWith(3, {
      message: "OAuth token file path:",
      default: ".typed-sheets/token.json",
    });
    expect(input).toHaveBeenNthCalledWith(4, {
      message: "Config file path:",
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
      message: "Service account JSON file path:",
    });
  });
});
