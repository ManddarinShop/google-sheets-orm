import { describe, expect, it } from "vitest";

import {
  parseTypedSheetsConfig,
  type TypedSheetsConfig,
} from "../src/setup/Config.js";

describe("typed sheets config", () => {
  it("parses an Apps Script gateway config", () => {
    expect(
      parseTypedSheetsConfig({
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
        defaultSheetName: "Users",
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
          gatewaySecret: "gateway-secret",
        },
      }),
    ).toEqual({
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
      defaultSheetName: "Users",
      auth: {
        type: "apps-script-gateway",
        gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
        gatewaySecret: "gateway-secret",
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
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
          gatewaySecret: "gateway-secret",
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
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
          gatewaySecret: "gateway-secret",
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
    ).toThrow(/auth.type must be "apps-script-gateway" or "service-account"/);
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

  it("rejects an Apps Script gateway config without a gateway URL", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "apps-script-gateway",
          gatewaySecret: "gateway-secret",
        },
      }),
    ).toThrow(/auth.gatewayUrl must be a non-empty string/);
  });

  it("rejects an Apps Script gateway config without a gateway secret", () => {
    expect(() =>
      parseTypedSheetsConfig({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
        },
      }),
    ).toThrow(/auth.gatewaySecret must be a non-empty string/);
  });
});
