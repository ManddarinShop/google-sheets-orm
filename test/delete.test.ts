import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/core/Columns.js";
import { ConflictError } from "../src/core/Errors.js";
import { createSheetRepository } from "../src/core/Repository.js";
import { FakeSheetAdapter } from "./fake-adapter.js";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

describe("repository deletes and optimistic locking", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("deletes a row by key and returns the deleted row", async () => {
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

    await expect(users.deleteById("u1")).resolves.toEqual({
      id: "u1",
      email: "a@test.com",
      age: 20,
      active: true,
      _version: 1,
    });
    expect(adapter.deletedRows).toEqual([]);
    expect(adapter.deletedRowBatches).toEqual([]);
    expect(adapter.deletedRowsByKey).toEqual([
      {
        sheetName: "Users",
        input: {
          expectedHeaders: ["id", "email", "age", "active", "_version"],
          keyHeader: "id",
          versionHeader: "_version",
          ids: ["u1"],
          versionsById: {
            u1: 1,
          },
        },
      },
    ]);
  });

  it("batches same-tick deletes by key", async () => {
    const sheet = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [
        { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
        { rowNumber: 3, cells: ["u2", "b@test.com", 21, false, 1] },
        { rowNumber: 4, cells: ["u3", "c@test.com", 22, true, 1] },
      ],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(
      Promise.all([users.deleteById("u1"), users.deleteById("u3")]),
    ).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      },
      {
        id: "u3",
        email: "c@test.com",
        age: 22,
        active: true,
        _version: 1,
      },
    ]);
    expect(adapter.deletedRows).toEqual([]);
    expect(adapter.deletedRowBatches).toEqual([]);
    expect(adapter.deletedRowsByKey).toEqual([
      {
        sheetName: "Users",
        input: {
          expectedHeaders: ["id", "email", "age", "active", "_version"],
          keyHeader: "id",
          versionHeader: "_version",
          ids: ["u1", "u3"],
          versionsById: {
            u1: 1,
            u3: 1,
          },
        },
      },
    ]);
  });

  it("uses adapter key-based batch delete when available", async () => {
    const sheet = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [
        { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
        { rowNumber: 3, cells: ["u2", "b@test.com", 21, false, 1] },
        { rowNumber: 4, cells: ["u3", "c@test.com", 22, true, 1] },
      ],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });
    adapter.deleteRowsByKey = async (sheetName, input) => {
      expect(sheetName).toBe("Users");
      expect(input).toEqual({
        expectedHeaders: ["id", "email", "age", "active", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        ids: ["u1", "u3"],
        versionsById: {
          u1: 1,
          u3: 1,
        },
      });

      return {
        deletedRows: [
          { id: "u1", cells: ["u1", "a@test.com", 20, true, 1] },
          { id: "u3", cells: ["u3", "c@test.com", 22, true, 1] },
        ],
      };
    };

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(
      Promise.all([users.deleteById("u1"), users.deleteById("u3")]),
    ).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      },
      {
        id: "u3",
        email: "c@test.com",
        age: 22,
        active: true,
        _version: 1,
      },
    ]);
    expect(adapter.readSheets).toEqual(["Users"]);
    expect(adapter.deletedRows).toEqual([]);
    expect(adapter.deletedRowBatches).toEqual([]);
  });

  it("returns null for duplicate ids after the first same-tick delete", async () => {
    const sheet = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] }],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(
      Promise.all([users.deleteById("u1"), users.deleteById("u1")]),
    ).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      },
      null,
    ]);
    expect(adapter.deletedRowBatches).toEqual([]);
  });

  it("returns null when the target row does not exist", async () => {
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

    await expect(users.deleteById("missing")).resolves.toBeNull();
    expect(adapter.deletedRows).toEqual([]);
  });

  it("rejects stale deletes when version changes before delete", async () => {
    const adapter = new FakeSheetAdapter({
      Users: [
        {
          headers: ["id", "email", "age", "active", "_version"],
          rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] }],
        },
        {
          headers: ["id", "email", "age", "active", "_version"],
          rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 2] }],
        },
      ],
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(users.deleteById("u1")).rejects.toThrow(ConflictError);
    expect(adapter.deletedRows).toEqual([]);
  });
});
