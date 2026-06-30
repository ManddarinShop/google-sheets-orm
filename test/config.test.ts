import { describe, expect, it } from "vitest";

import {
  parseTypedSheetsConfig,
  type TypedSheetsConfig,
} from "../src/setup/Config.js";

describe("typed sheets config", () => {
  it("parses an OAuth config with a spreadsheet URL and default sheet name", () => {
    expect(
      parseTypedSheetsConfig({
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
        defaultSheetName: "Users",
        auth: {
          type: "oauth",
          tokenFile: ".typed-sheets/token.json",
        },
      }),
    ).toEqual({
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
      defaultSheetName: "Users",
      auth: {
        type: "oauth",
        tokenFile: ".typed-sheets/token.json",
      },
    } satisfies TypedSheetsConfig);
  });

  it("parses a service account config", () => {
    expect(
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "service-account",
          credentialsFile: "/absolute/path/to/service-account.json",
        },
      }),
    ).toEqual({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      defaultSheetName: "Users",
      auth: {
        type: "service-account",
        credentialsFile: "/absolute/path/to/service-account.json",
      },
    } satisfies TypedSheetsConfig);
  });

  it("rejects non-object config values", () => {
    expect(() => parseTypedSheetsConfig(null)).toThrow(/config must be an object/);
    expect(() => parseTypedSheetsConfig("invalid")).toThrow(
      /config must be an object/,
    );
  });

  it("rejects invalid spreadsheet URLs", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://example.com/not-a-sheet",
        defaultSheetName: "Users",
        auth: {
          type: "oauth",
          tokenFile: ".typed-sheets/token.json",
        },
      }),
    ).toThrow(/spreadsheetUrl must be a Google Sheets URL/);
  });

  it("rejects empty default sheet names", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: " ",
        auth: {
          type: "oauth",
          tokenFile: ".typed-sheets/token.json",
        },
      }),
    ).toThrow(/defaultSheetName must be a non-empty string/);
  });

  it("rejects unsupported auth types", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "api-key",
        },
      }),
    ).toThrow(/auth.type must be "oauth" or "service-account"/);
  });

  it("rejects service account config without a credentials file", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "service-account",
        },
      }),
    ).toThrow(/auth.credentialsFile must be a non-empty string/);
  });

  it("rejects OAuth config without a token file", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "oauth",
        },
      }),
    ).toThrow(/auth.tokenFile must be a non-empty string/);
  });
});
