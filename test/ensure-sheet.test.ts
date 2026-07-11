import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/core/schema/index.js";
import { SchemaDriftError } from "../src/core/errors/index.js";
import { createSheetRepository } from "../src/core/repository/index.js";
import type {
  AppsScriptQueueAdapter,
  DirectSheetAdapter,
  SheetSnapshot,
} from "../src/adapter/Adapter.js";
import { FakeSheetAdapter } from "./fake-adapter.js";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

type InitializableRepository = {
  ensureSheet(): Promise<void>;
};

describe("repository sheet initialization", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("creates the sheet and writes schema headers when the header row is empty", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: [],
        rows: [],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    }) as unknown as InitializableRepository;

    await users.ensureSheet();

    expect(adapter.ensuredSheets).toEqual(["Users"]);
    expect(adapter.writtenHeaders).toEqual([
      {
        sheetName: "Users",
        headers: ["id", "email", "age", "active", "_version"],
      },
    ]);
  });

  it("uses atomic adapter initialization when available", async () => {
    const initializedSheets: Array<{ sheetName: string; headers: string[] }> =
      [];
    const snapshot: SheetSnapshot = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [],
    };
    const adapter: DirectSheetAdapter = {
      async initializeSheet(sheetName, headers) {
        initializedSheets.push({ sheetName, headers: [...headers] });
      },
      async readSheet() {
        return snapshot;
      },
      async appendRow() {},
      async updateRow() {},
      async ensureSheet() {
        throw new Error("ensureSheet should not be called");
      },
      async writeHeader() {
        throw new Error("writeHeader should not be called");
      },
    };

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    }) as unknown as InitializableRepository;

    await users.ensureSheet();

    expect(initializedSheets).toEqual([
      {
        sheetName: "Users",
        headers: ["id", "email", "age", "active", "_version"],
      },
    ]);
  });

  it("keeps repository initialization on initializeSheet until system sheet routing exists", async () => {
    const initializedSystemSheets: Array<{
      sheetName: string;
      headers: string[];
    }> = [];
    const initializedSheets: Array<{ sheetName: string; headers: string[] }> =
      [];
    const snapshot: SheetSnapshot = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [],
    };
    const adapter: DirectSheetAdapter &
      Pick<AppsScriptQueueAdapter, "initializeSystemSheets"> = {
      async initializeSystemSheets(sheetName, headers) {
        initializedSystemSheets.push({ sheetName, headers: [...headers] });

        return {
          logicalSheetName: sheetName,
          canonicalSheetName: "_typed_sheets_data_Users_a1b2c3d4e5f6",
          projectionSheetName: sheetName,
          taskQueueSheetName: "_typed_sheets_task_queue",
        };
      },
      async initializeSheet(sheetName, headers) {
        initializedSheets.push({ sheetName, headers: [...headers] });
      },
      async readSheet() {
        return snapshot;
      },
      async appendRow() {},
      async updateRow() {},
      async ensureSheet() {
        throw new Error("ensureSheet should not be called");
      },
      async writeHeader() {
        throw new Error("writeHeader should not be called");
      },
    };

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    }) as unknown as InitializableRepository;

    await users.ensureSheet();

    expect(initializedSystemSheets).toEqual([]);
    expect(initializedSheets).toEqual([
      {
        sheetName: "Users",
        headers: ["id", "email", "age", "active", "_version"],
      },
    ]);
  });

  it("does not rewrite headers when the existing schema matches", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email", "age", "active", "_version"],
        rows: [],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    }) as unknown as InitializableRepository;

    await users.ensureSheet();

    expect(adapter.ensuredSheets).toEqual(["Users"]);
    expect(adapter.writtenHeaders).toEqual([]);
  });

  it("fails instead of rewriting headers when the existing schema drifted", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email_address", "age", "active", "_version"],
        rows: [],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    }) as unknown as InitializableRepository;

    await expect(users.ensureSheet()).rejects.toThrow(SchemaDriftError);

    expect(adapter.ensuredSheets).toEqual(["Users"]);
    expect(adapter.writtenHeaders).toEqual([]);
  });
});
