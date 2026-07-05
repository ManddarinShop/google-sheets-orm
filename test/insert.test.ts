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

describe("repository inserts", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("appends a row in sheet header order", async () => {
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
    });

    await users.insert({
      id: "u1",
      email: "a@test.com",
      age: 20,
      active: true,
      _version: 1,
    });

    expect(adapter.appendedRowBatches).toEqual([
      {
        sheetName: "Users",
        rows: [["u1", "a@test.com", 20, true, 1]],
      },
    ]);
  });

  it("serializes undefined optional values as null", async () => {
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
    });

    await users.insert({
      id: "u1",
      email: "a@test.com",
      age: undefined,
      active: true,
      _version: 1,
    });

    expect(adapter.appendedRowBatches[0]?.rows[0]).toEqual([
      "u1",
      "a@test.com",
      null,
      true,
      1,
    ]);
  });

  it("uses sheet header order instead of schema declaration order", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["_version", "active", "age", "email", "id"],
        rows: [],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await users.insert({
      id: "u1",
      email: "a@test.com",
      age: 20,
      active: true,
      _version: 1,
    });

    expect(adapter.appendedRowBatches[0]?.rows[0]).toEqual([
      1,
      true,
      20,
      "a@test.com",
      "u1",
    ]);
  });

  it("rejects duplicate keys before appending", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email", "age", "active", "_version"],
        rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] }],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(
      users.insert({
        id: "u1",
        email: "duplicate@test.com",
        age: 30,
        active: false,
        _version: 1,
      }),
    ).rejects.toThrow(SchemaDriftError);

    expect(adapter.appendedRows).toEqual([]);
    expect(adapter.appendedRowBatches).toEqual([]);
  });

  it("batches same-tick inserts into one adapter call", async () => {
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
    });

    await Promise.all([
      users.insert({
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      }),
      users.insert({
        id: "u2",
        email: "b@test.com",
        age: 21,
        active: false,
        _version: 1,
      }),
    ]);

    expect(adapter.appendedRows).toEqual([]);
    expect(adapter.appendedRowBatches).toEqual([
      {
        sheetName: "Users",
        rows: [
          ["u1", "a@test.com", 20, true, 1],
          ["u2", "b@test.com", 21, false, 1],
        ],
      },
    ]);
  });

  it("rejects duplicate keys within the same insert batch", async () => {
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
    });

    await expect(
      Promise.all([
        users.insert({
          id: "u1",
          email: "a@test.com",
          age: 20,
          active: true,
          _version: 1,
        }),
        users.insert({
          id: "u1",
          email: "duplicate@test.com",
          age: 21,
          active: false,
          _version: 1,
        }),
      ]),
    ).rejects.toThrow(SchemaDriftError);

    expect(adapter.appendedRows).toEqual([]);
    expect(adapter.appendedRowBatches).toEqual([]);
  });
});
