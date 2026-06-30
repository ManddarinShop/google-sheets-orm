import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { runSetup, type SetupPrompt } from "../src/setup/Setup.js";

describe("interactive setup flow", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "typed-sheets-setup-"));
    tempDirs.push(dir);
    return dir;
  }

  it("asks setup questions and writes an OAuth config", async () => {
    const cwd = await createTempDir();
    const promptCalls: string[] = [];
    const prompt: SetupPrompt = {
      selectAuthType: async () => {
        promptCalls.push("selectAuthType");
        return "oauth";
      },
      inputSpreadsheetUrl: async () => {
        promptCalls.push("inputSpreadsheetUrl");
        return "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit";
      },
      inputDefaultSheetName: async () => {
        promptCalls.push("inputDefaultSheetName");
        return "Users";
      },
      inputOAuthTokenFile: async () => {
        promptCalls.push("inputOAuthTokenFile");
        return ".typed-sheets/token.json";
      },
      inputConfigPath: async () => {
        promptCalls.push("inputConfigPath");
        return ".typed-sheets.json";
      },
    };

    await runSetup({ cwd, prompt });

    expect(promptCalls).toEqual([
      "selectAuthType",
      "inputSpreadsheetUrl",
      "inputDefaultSheetName",
      "inputOAuthTokenFile",
      "inputConfigPath",
    ]);
    await expect(readFile(join(cwd, ".typed-sheets.json"), "utf8")).resolves.toBe(
      [
        "{",
        '  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",',
        '  "defaultSheetName": "Users",',
        '  "auth": {',
        '    "type": "oauth",',
        '    "tokenFile": ".typed-sheets/token.json"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("asks for service account credentials when service account auth is selected", async () => {
    const cwd = await createTempDir();
    const promptCalls: string[] = [];
    const prompt: SetupPrompt = {
      selectAuthType: async () => {
        promptCalls.push("selectAuthType");
        return "service-account";
      },
      inputSpreadsheetUrl: async () => {
        promptCalls.push("inputSpreadsheetUrl");
        return "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit";
      },
      inputDefaultSheetName: async () => {
        promptCalls.push("inputDefaultSheetName");
        return "Users";
      },
      inputOAuthTokenFile: async () => {
        throw new Error("should not ask for OAuth token file");
      },
      inputServiceAccountCredentialsFile: async () => {
        promptCalls.push("inputServiceAccountCredentialsFile");
        return "/absolute/path/to/service-account.json";
      },
      inputConfigPath: async () => {
        promptCalls.push("inputConfigPath");
        return ".typed-sheets.json";
      },
    };

    await runSetup({ cwd, prompt });

    expect(promptCalls).toEqual([
      "selectAuthType",
      "inputSpreadsheetUrl",
      "inputDefaultSheetName",
      "inputServiceAccountCredentialsFile",
      "inputConfigPath",
    ]);
    await expect(readFile(join(cwd, ".typed-sheets.json"), "utf8")).resolves.toBe(
      [
        "{",
        '  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",',
        '  "defaultSheetName": "Users",',
        '  "auth": {',
        '    "type": "service-account",',
        '    "credentialsFile": "/absolute/path/to/service-account.json"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("does not ask for service account credentials when OAuth auth is selected", async () => {
    const cwd = await createTempDir();
    const prompt: SetupPrompt = {
      selectAuthType: async () => "oauth",
      inputSpreadsheetUrl: async () =>
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      inputDefaultSheetName: async () => "Users",
      inputOAuthTokenFile: async () => ".typed-sheets/token.json",
      inputServiceAccountCredentialsFile: async () => {
        throw new Error("should not ask for service account credentials");
      },
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await expect(runSetup({ cwd, prompt })).resolves.toBeUndefined();
  });
});
