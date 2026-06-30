import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadTypedSheetsConfig } from "../src/setup/ConfigLoader.js";
import { writeTypedSheetsConfig } from "../src/setup/ConfigWriter.js";

describe("typed sheets config writer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "typed-sheets-config-writer-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes .typed-sheets.json to a directory", async () => {
    const dir = await createTempDir();

    await writeTypedSheetsConfig({
      cwd: dir,
      config: {
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "oauth",
          tokenFile: ".typed-sheets/token.json",
        },
      },
    });

    await expect(loadTypedSheetsConfig({ cwd: dir })).resolves.toEqual({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      defaultSheetName: "Users",
      auth: {
        type: "oauth",
        tokenFile: ".typed-sheets/token.json",
      },
    });
  });

  it("writes an explicit config path", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "typed-sheets.config.json");

    await writeTypedSheetsConfig({
      configPath,
      config: {
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
        defaultSheetName: "Users",
        auth: {
          type: "service-account",
          credentialsFile: "/absolute/path/to/service-account.json",
        },
      },
    });

    await expect(loadTypedSheetsConfig({ configPath })).resolves.toEqual({
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
      defaultSheetName: "Users",
      auth: {
        type: "service-account",
        credentialsFile: "/absolute/path/to/service-account.json",
      },
    });
  });

  it("formats JSON with a trailing newline", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, ".typed-sheets.json");

    await writeTypedSheetsConfig({
      cwd: dir,
      config: {
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "oauth",
          tokenFile: ".typed-sheets/token.json",
        },
      },
    });

    await expect(readFile(configPath, "utf8")).resolves.toBe(
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
});
