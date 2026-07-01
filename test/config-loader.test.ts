import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadTypedSheetsConfig } from "../src/setup/ConfigLoader.js";

describe("typed sheets config loader", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "typed-sheets-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads .typed-sheets.json from a directory", async () => {
    const dir = await createTempDir();

    await writeFile(
      join(dir, ".typed-sheets.json"),
      JSON.stringify({
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
        defaultSheetName: "Users",
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
          gatewaySecret: "gateway-secret",
        },
      }),
    );

    await expect(loadTypedSheetsConfig({ cwd: dir })).resolves.toEqual({
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
      defaultSheetName: "Users",
      auth: {
        type: "apps-script-gateway",
        gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
        gatewaySecret: "gateway-secret",
      },
    });
  });

  it("loads an explicit config path", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "typed-sheets.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "service-account",
          credentialsFile: "/absolute/path/to/service-account.json",
        },
      }),
    );

    await expect(loadTypedSheetsConfig({ configPath })).resolves.toEqual({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      defaultSheetName: "Users",
      auth: {
        type: "service-account",
        credentialsFile: "/absolute/path/to/service-account.json",
      },
    });
  });

  it("fails when the config file is missing", async () => {
    const dir = await createTempDir();

    await expect(loadTypedSheetsConfig({ cwd: dir })).rejects.toThrow(
      /typed-sheets config file was not found/,
    );
  });

  it("fails when the config file contains invalid JSON", async () => {
    const dir = await createTempDir();

    await writeFile(join(dir, ".typed-sheets.json"), "{ invalid json");

    await expect(loadTypedSheetsConfig({ cwd: dir })).rejects.toThrow(
      /typed-sheets config file contains invalid JSON/,
    );
  });

  it("fails when the config file contains invalid config", async () => {
    const dir = await createTempDir();

    await writeFile(
      join(dir, ".typed-sheets.json"),
      JSON.stringify({
        spreadsheetUrl: "https://example.com/not-a-sheet",
        defaultSheetName: "Users",
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
          gatewaySecret: "gateway-secret",
        },
      }),
    );

    await expect(loadTypedSheetsConfig({ cwd: dir })).rejects.toThrow(
      /spreadsheetUrl must be a Google Sheets URL/,
    );
  });
});
