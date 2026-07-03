import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createClipboardCopyCommand } from "../src/setup/ManualAppsScriptGateway.js";
import {
  parseAppsScriptGatewayConfigInput,
  runSetup,
  type SetupPrompt,
} from "../src/setup/Setup.js";

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

  it("ships the manual Apps Script template files referenced by setup", async () => {
    await expect(
      readFile("templates/manual-apps-script-gateway/Code.gs", "utf8"),
    ).resolves.toContain("function setupTypedSheets()");
    await expect(
      readFile("templates/manual-apps-script-gateway/SheetInfo.gs", "utf8"),
    ).resolves.toContain("function setupTypedSheetsSheetInfo()");
  });

  it("selects the clipboard copy command for the current platform", () => {
    expect(createClipboardCopyCommand("Code.gs", "darwin")).toBe(
      "pbcopy < Code.gs",
    );
    expect(createClipboardCopyCommand("Code.gs", "win32")).toBe(
      "Get-Content Code.gs | Set-Clipboard",
    );
    expect(createClipboardCopyCommand("Code.gs", "linux")).toBe(
      "xclip -selection clipboard < Code.gs",
    );
  });

  it("asks gateway questions and writes an Apps Script gateway config", async () => {
    const cwd = await createTempDir();
    const promptCalls: string[] = [];
    const messages: string[] = [];
    const prompt: SetupPrompt = {
      selectAuthType: async () => {
        promptCalls.push("selectAuthType");
        return "apps-script-gateway";
      },
      showMessage: async (message) => {
        promptCalls.push("showMessage");
        messages.push(message);
      },
      selectAppsScriptCodePrintMode: async () => {
        promptCalls.push("selectAppsScriptCodePrintMode");
        return "none";
      },
      inputSpreadsheetUrl: async () => {
        throw new Error("should not ask for spreadsheet URL");
      },
      inputDefaultSheetName: async () => {
        throw new Error("should not ask for default sheet name");
      },
      inputAppsScriptGatewayConfig: async () => {
        promptCalls.push("inputAppsScriptGatewayConfig");
        return JSON.stringify({
          spreadsheetUrl:
            "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
          defaultSheetName: "Users",
          auth: {
            type: "apps-script-gateway",
            gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
            gatewaySecret: "gateway-secret",
          },
        });
      },
      inputConfigPath: async () => {
        promptCalls.push("inputConfigPath");
        return ".typed-sheets.json";
      },
    };

    await runSetup({ cwd, platform: "darwin", prompt });

    expect(promptCalls).toEqual([
      "showMessage",
      "selectAuthType",
      "showMessage",
      "selectAppsScriptCodePrintMode",
      "inputAppsScriptGatewayConfig",
      "inputConfigPath",
      "showMessage",
    ]);
    expect(messages[0]).toContain("typed-sheets setup");
    expect(messages[1]).toContain("templates/manual-apps-script-gateway/Code.gs");
    expect(messages[1]).toContain("templates/manual-apps-script-gateway/SheetInfo.gs");
    expect(messages[1]).toContain("pbcopy < templates/manual-apps-script-gateway/Code.gs");
    expect(messages[1]).toContain("Run only. No Web App deployment.");
    expect(messages[1]).toContain("Deploy > New deployment > Web app");
    expect(messages[1]).not.toContain("function setupTypedSheets()");
    expect(messages[2]).toBe("Created .typed-sheets.json");
    await expect(readFile(join(cwd, ".typed-sheets.json"), "utf8")).resolves.toBe(
      [
        "{",
        '  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",',
        '  "defaultSheetName": "Users",',
        '  "auth": {',
        '    "type": "apps-script-gateway",',
        '    "gatewayUrl": "https://script.google.com/macros/s/deployment-id/exec",',
        '    "gatewaySecret": "gateway-secret"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("prints the gateway copy command without dumping the script body", async () => {
    const cwd = await createTempDir();
    const messages: string[] = [];
    const prompt: SetupPrompt = {
      selectAuthType: async () => "apps-script-gateway",
      showMessage: async (message) => {
        messages.push(message);
      },
      selectAppsScriptCodePrintMode: async () => "gateway",
      inputSpreadsheetUrl: async () => {
        throw new Error("should not ask for spreadsheet URL");
      },
      inputDefaultSheetName: async () => {
        throw new Error("should not ask for default sheet name");
      },
      inputAppsScriptGatewayConfig: async () =>
        JSON.stringify({
          spreadsheetUrl:
            "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
          defaultSheetName: "Users",
          auth: {
            type: "apps-script-gateway",
            gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
            gatewaySecret: "gateway-secret",
          },
        }),
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await runSetup({ cwd, platform: "win32", prompt });

    expect(messages.some((message) => message.includes("Code.gs"))).toBe(true);
    expect(
      messages.some((message) =>
        message.includes(
          "Get-Content templates/manual-apps-script-gateway/Code.gs | Set-Clipboard",
        ),
      ),
    ).toBe(true);
    expect(
      messages.some((message) => message.includes("function setupTypedSheets()")),
    ).toBe(false);
  });

  it("prints the small sheet info helper when requested", async () => {
    const cwd = await createTempDir();
    const messages: string[] = [];
    const prompt: SetupPrompt = {
      selectAuthType: async () => "apps-script-gateway",
      showMessage: async (message) => {
        messages.push(message);
      },
      selectAppsScriptCodePrintMode: async () => "sheet-info",
      inputSpreadsheetUrl: async () => {
        throw new Error("should not ask for spreadsheet URL");
      },
      inputDefaultSheetName: async () => {
        throw new Error("should not ask for default sheet name");
      },
      inputAppsScriptGatewayConfig: async () =>
        JSON.stringify({
          spreadsheetUrl:
            "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
          defaultSheetName: "Users",
          auth: {
            type: "apps-script-gateway",
            gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
            gatewaySecret: "gateway-secret",
          },
        }),
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await runSetup({ cwd, platform: "darwin", prompt });

    expect(messages.some((message) => message.includes("SheetInfo.gs"))).toBe(
      true,
    );
    expect(
      messages.some((message) =>
        message.includes("pbcopy < templates/manual-apps-script-gateway/SheetInfo.gs"),
      ),
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.includes("function setupTypedSheetsSheetInfo()"),
      ),
    ).toBe(false);
    expect(
      messages.some((message) => message.includes("Deployment is not needed")),
    ).toBe(true);
  });

  it("requires gateway prompt methods when Apps Script gateway auth is selected", async () => {
    const cwd = await createTempDir();
    const prompt: SetupPrompt = {
      selectAuthType: async () => "apps-script-gateway",
      showMessage: async () => undefined,
      inputSpreadsheetUrl: async () =>
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      inputDefaultSheetName: async () => "Users",
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await expect(runSetup({ cwd, prompt })).rejects.toThrow(
      /inputAppsScriptGatewayConfig is required for apps-script-gateway auth/,
    );
  });

  it("rejects invalid Apps Script gateway config JSON", async () => {
    const cwd = await createTempDir();
    const prompt: SetupPrompt = {
      selectAuthType: async () => "apps-script-gateway",
      showMessage: async () => undefined,
      selectAppsScriptCodePrintMode: async () => "none",
      inputSpreadsheetUrl: async () => {
        throw new Error("should not ask for spreadsheet URL");
      },
      inputDefaultSheetName: async () => {
        throw new Error("should not ask for default sheet name");
      },
      inputAppsScriptGatewayConfig: async () => "{ invalid json",
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await expect(runSetup({ cwd, prompt })).rejects.toThrow(
      /Apps Script gateway config must contain valid JSON/,
    );
  });

  it("extracts Apps Script gateway config JSON from pasted execution logs", async () => {
    const cwd = await createTempDir();
    const prompt: SetupPrompt = {
      selectAuthType: async () => "apps-script-gateway",
      showMessage: async () => undefined,
      selectAppsScriptCodePrintMode: async () => "none",
      inputSpreadsheetUrl: async () => {
        throw new Error("should not ask for spreadsheet URL");
      },
      inputDefaultSheetName: async () => {
        throw new Error("should not ask for default sheet name");
      },
      inputAppsScriptGatewayConfig: async () =>
        [
          "12:34:56 PM Info typed-sheets config was generated",
          "{",
          '  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",',
          '  "defaultSheetName": "Users",',
          '  "auth": {',
          '    "type": "apps-script-gateway",',
          '    "gatewayUrl": "https://script.google.com/macros/s/deployment-id/exec",',
          '    "gatewaySecret": "gateway-secret"',
          "  }",
          "}",
          "12:34:57 PM Notice Execution completed",
        ].join("\n"),
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await runSetup({ cwd, prompt });

    await expect(readFile(join(cwd, ".typed-sheets.json"), "utf8")).resolves.toBe(
      [
        "{",
        '  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",',
        '  "defaultSheetName": "Users",',
        '  "auth": {',
        '    "type": "apps-script-gateway",',
        '    "gatewayUrl": "https://script.google.com/macros/s/deployment-id/exec",',
        '    "gatewaySecret": "gateway-secret"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("keeps braces inside log JSON strings intact", () => {
    expect(
      parseAppsScriptGatewayConfigInput(
        [
          "Info before JSON",
          "{",
          '  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",',
          '  "defaultSheetName": "Users {prod}",',
          '  "auth": {',
          '    "type": "apps-script-gateway",',
          '    "gatewayUrl": "https://script.google.com/macros/s/deployment-id/exec",',
          '    "gatewaySecret": "secret-with-}-brace"',
          "  }",
          "}",
          "Info after JSON",
        ].join("\n"),
      ),
    ).toEqual({
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      defaultSheetName: "Users {prod}",
      auth: {
        type: "apps-script-gateway",
        gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
        gatewaySecret: "secret-with-}-brace",
      },
    });
  });

  it("asks for service account credentials when service account auth is selected", async () => {
    const cwd = await createTempDir();
    const promptCalls: string[] = [];
    const messages: string[] = [];
    const prompt: SetupPrompt = {
      selectAuthType: async () => {
        promptCalls.push("selectAuthType");
        return "service-account";
      },
      showMessage: async (message) => {
        promptCalls.push("showMessage");
        messages.push(message);
      },
      inputSpreadsheetUrl: async () => {
        promptCalls.push("inputSpreadsheetUrl");
        return "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit";
      },
      inputDefaultSheetName: async () => {
        promptCalls.push("inputDefaultSheetName");
        return "Users";
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
      "showMessage",
      "selectAuthType",
      "showMessage",
      "inputSpreadsheetUrl",
      "inputDefaultSheetName",
      "inputServiceAccountCredentialsFile",
      "inputConfigPath",
      "showMessage",
    ]);
    expect(messages[1]).toContain("Service account setup");
    expect(messages[1]).toContain("client_email");
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

  it("does not ask for service account credentials when Apps Script gateway auth is selected", async () => {
    const cwd = await createTempDir();
    const prompt: SetupPrompt = {
      selectAuthType: async () => "apps-script-gateway",
      showMessage: async () => undefined,
      selectAppsScriptCodePrintMode: async () => "none",
      inputSpreadsheetUrl: async () =>
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      inputDefaultSheetName: async () => "Users",
      inputAppsScriptGatewayConfig: async () =>
        JSON.stringify({
          spreadsheetUrl:
            "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
          defaultSheetName: "Users",
          auth: {
            type: "apps-script-gateway",
            gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
            gatewaySecret: "gateway-secret",
          },
        }),
      inputServiceAccountCredentialsFile: async () => {
        throw new Error("should not ask for service account credentials");
      },
      inputConfigPath: async () => ".typed-sheets.json",
    };

    await expect(runSetup({ cwd, prompt })).resolves.toBeUndefined();
  });
});
