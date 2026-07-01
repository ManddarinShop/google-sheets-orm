import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  boolean,
  createRepositoryFromConfig,
  number,
  text,
} from "../../src/index.js";
import type { SheetRepository } from "../../src/core/Repository.js";
import { writeTypedSheetsConfig } from "../../src/setup/ConfigWriter.js";

interface SmokeUser {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

const spreadsheetUrl = process.env.GOOGLE_SPREADSHEET_URL;
const serviceAccountCredentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const serviceAccountSheetName =
  process.env.GOOGLE_SERVICE_ACCOUNT_SHEET_NAME ??
  process.env.GOOGLE_SHEET_NAME ??
  "Users";
const gatewayUrl = process.env.GOOGLE_APPS_SCRIPT_GATEWAY_URL;
const gatewaySecret = process.env.GOOGLE_APPS_SCRIPT_GATEWAY_SECRET;
const gatewaySheetName =
  process.env.GOOGLE_APPS_SCRIPT_GATEWAY_SHEET_NAME ??
  process.env.GOOGLE_SHEET_NAME ??
  "Users";

const columns = {
  id: text(),
  email: text(),
  age: number().optional(),
  active: boolean(),
  _version: number(),
};

const describeServiceAccountIntegration =
  spreadsheetUrl && serviceAccountCredentialsFile ? describe : describe.skip;
const describeGatewayIntegration =
  spreadsheetUrl && gatewayUrl && gatewaySecret ? describe : describe.skip;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "typed-sheets-smoke-"));
  tempDirs.push(dir);
  return dir;
}

async function expectRepositoryCrud(input: {
  users: SheetRepository<SmokeUser>;
  idPrefix: string;
  ensureSheet: boolean;
}): Promise<void> {
  const id = `${input.idPrefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

  if (input.ensureSheet) {
    await input.users.ensureSheet();
  }

  await input.users.insert({
    id,
    email: `${id}@example.com`,
    age: undefined,
    active: true,
    _version: 1,
  });

  await expect(input.users.findById(id)).resolves.toEqual({
    id,
    email: `${id}@example.com`,
    age: undefined,
    active: true,
    _version: 1,
  });

  await expect(input.users.findAll()).resolves.toContainEqual({
    id,
    email: `${id}@example.com`,
    age: undefined,
    active: true,
    _version: 1,
  });

  await expect(
    input.users.update(id, (current) => ({
      ...current,
      age: 42,
    })),
  ).resolves.toEqual({
    id,
    email: `${id}@example.com`,
    age: 42,
    active: true,
    _version: 2,
  });

  await expect(input.users.findById(id)).resolves.toMatchObject({
    id,
    age: 42,
    _version: 2,
  });

  await expect(input.users.deleteById(id)).resolves.toMatchObject({
    id,
    age: 42,
    _version: 2,
  });
  await expect(input.users.findById(id)).resolves.toBeNull();
}

describeServiceAccountIntegration("Google Sheets service-account smoke test", () => {
  it("creates a repository from config and runs CRUD through the direct API adapter", async () => {
    const cwd = await createTempDir();

    await writeTypedSheetsConfig({
      cwd,
      config: {
        spreadsheetUrl: spreadsheetUrl!,
        defaultSheetName: serviceAccountSheetName,
        auth: {
          type: "service-account",
          credentialsFile: serviceAccountCredentialsFile!,
        },
      },
    });

    const users = await createRepositoryFromConfig<SmokeUser>({
      cwd,
      key: "id",
      columns,
    });

    await expectRepositoryCrud({
      users,
      idPrefix: "service-account-smoke",
      ensureSheet: true,
    });
  }, 60_000);
});

describeGatewayIntegration("Google Sheets Apps Script gateway smoke test", () => {
  it("creates a repository from config and runs CRUD through the gateway adapter", async () => {
    const cwd = await createTempDir();

    await writeTypedSheetsConfig({
      cwd,
      config: {
        spreadsheetUrl: spreadsheetUrl!,
        defaultSheetName: gatewaySheetName,
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: gatewayUrl!,
          gatewaySecret: gatewaySecret!,
        },
      },
    });

    const users = await createRepositoryFromConfig<SmokeUser>({
      cwd,
      key: "id",
      columns,
    });

    await expectRepositoryCrud({
      users,
      idPrefix: "gateway-smoke",
      ensureSheet: true,
    });
  }, 60_000);
});
