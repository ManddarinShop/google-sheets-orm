import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { boolean, number, text } from "../src/core/Columns.js";
import { createRepositoryFromConfig } from "../src/index.js";
import { writeTypedSheetsConfig } from "../src/setup/ConfigWriter.js";
import { FakeSheetAdapter } from "./fake-adapter.js";

interface User {
  id: string;
  email: string;
  active: boolean;
  _version: number;
}

describe("runtime repository factory", () => {
  const tempDirs: string[] = [];
  const columns = {
    id: text(),
    email: text(),
    active: boolean(),
    _version: number(),
  };

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "typed-sheets-runtime-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads a service account config and creates a repository for the default sheet", async () => {
    const cwd = await createTempDir();
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email", "active", "_version"],
        rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", true, 1] }],
      },
    });
    const createdAdapters: unknown[] = [];

    await writeTypedSheetsConfig({
      cwd,
      config: {
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "service-account",
          credentialsFile: "/absolute/path/to/service-account.json",
        },
      },
    });

    const users = await createRepositoryFromConfig<User>({
      cwd,
      key: "id",
      columns,
      createAdapter: (config) => {
        createdAdapters.push(config);
        return adapter;
      },
    });

    await expect(users.findAll()).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        active: true,
        _version: 1,
      },
    ]);
    expect(createdAdapters).toEqual([
      {
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "service-account",
          credentialsFile: "/absolute/path/to/service-account.json",
        },
      },
    ]);
  });

  it("uses an explicit config path when provided", async () => {
    const cwd = await createTempDir();
    const adapter = new FakeSheetAdapter({
      Members: {
        headers: ["id", "email", "active", "_version"],
        rows: [{ rowNumber: 2, cells: ["m1", "member@test.com", false, 3] }],
      },
    });

    await writeTypedSheetsConfig({
      configPath: join(cwd, "typed-sheets.members.json"),
      config: {
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Members",
        auth: {
          type: "service-account",
          credentialsFile: "/absolute/path/to/service-account.json",
        },
      },
    });

    const members = await createRepositoryFromConfig<User>({
      cwd,
      configPath: join(cwd, "typed-sheets.members.json"),
      key: "id",
      columns,
      createAdapter: () => adapter,
    });

    await expect(members.findById("m1")).resolves.toEqual({
      id: "m1",
      email: "member@test.com",
      active: false,
      _version: 3,
    });
  });

  it("creates a repository backed by an Apps Script gateway config", async () => {
    const cwd = await createTempDir();
    const fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        headers: ["id", "email", "active", "_version"],
        rows: [{ rowNumber: 2, cells: ["u1", "gateway@test.com", true, 1] }],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetch);

    await writeTypedSheetsConfig({
      cwd,
      config: {
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
        defaultSheetName: "Users",
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
          gatewaySecret: "gateway-secret",
        },
      },
    });

    const users = await createRepositoryFromConfig<User>({
      cwd,
      key: "id",
      columns,
    });

    await expect(users.findAll()).resolves.toEqual([
      {
        id: "u1",
        email: "gateway@test.com",
        active: true,
        _version: 1,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] as [
      string,
      RequestInit & { body: string },
    ];

    expect(url).toBe("https://script.google.com/macros/s/deployment-id/exec");
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({
      "content-type": "application/json",
    });
    expect(JSON.parse(request.body)).toEqual({
      operation: "readSheet",
      secret: "gateway-secret",
      sheetName: "Users",
    });
  });
});
