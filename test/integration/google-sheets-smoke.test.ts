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

const describeServiceAccountIntegration = createIntegrationDescribe({
  name: "Google Sheets service-account smoke test",
  missingEnv: [
    ["GOOGLE_SPREADSHEET_URL", spreadsheetUrl],
    ["GOOGLE_APPLICATION_CREDENTIALS", serviceAccountCredentialsFile],
  ],
});
const describeGatewayIntegration = createIntegrationDescribe({
  name: "Google Sheets Apps Script gateway smoke test",
  missingEnv: [
    ["GOOGLE_SPREADSHEET_URL", spreadsheetUrl],
    ["GOOGLE_APPS_SCRIPT_GATEWAY_URL", gatewayUrl],
    ["GOOGLE_APPS_SCRIPT_GATEWAY_SECRET", gatewaySecret],
  ],
});

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

function createIntegrationDescribe(input: {
  name: string;
  missingEnv: Array<[string, string | undefined]>;
}): (factory: () => void) => void {
  const missingNames = input.missingEnv
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingNames.length === 0) {
    return (factory) => describe(input.name, factory);
  }

  return (factory) =>
    describe.skip(
      `${input.name} (skipped: missing ${missingNames.join(", ")})`,
      factory,
    );
}

async function expectRepositoryCrud(input: {
  users: SheetRepository<SmokeUser>;
  idPrefix: string;
  ensureSheet: boolean;
}): Promise<void> {
  const id = `${input.idPrefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  let inserted = false;
  let deleted = false;

  if (input.ensureSheet) {
    await input.users.ensureSheet();
  }

  try {
    const insertedRow = {
      id,
      email: `${id}@example.com`,
      age: undefined,
      active: true,
      _version: 1,
    };
    const updatedRow = {
      ...insertedRow,
      age: 42,
      _version: insertedRow._version + 1,
    };

    await input.users.insert(insertedRow);
    inserted = true;

    await expect(input.users.findById(id)).resolves.toEqual(insertedRow);
    await expect(input.users.findAll()).resolves.toContainEqual(insertedRow);

    await expect(
      input.users.update(id, (current) => ({
        ...current,
        age: 42,
      })),
    ).resolves.toEqual(updatedRow);

    await expect(input.users.findById(id)).resolves.toEqual(updatedRow);
    await expect(input.users.findAll()).resolves.toContainEqual(updatedRow);

    await expect(input.users.deleteById(id)).resolves.toEqual(updatedRow);
    deleted = true;

    await expect(input.users.findById(id)).resolves.toBeNull();
    await expect(input.users.findAll()).resolves.not.toContainEqual(updatedRow);
    await expect(input.users.deleteById(id)).resolves.toBeNull();
  } finally {
    if (inserted && !deleted) {
      await input.users.deleteById(id);
    }
  }
}

describeServiceAccountIntegration(() => {
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

describeGatewayIntegration(() => {
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
