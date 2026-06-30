import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/core/Columns.js";
import { SchemaDriftError } from "../src/core/Errors.js";
import { createSheetRepository } from "../src/core/Repository.js";
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
