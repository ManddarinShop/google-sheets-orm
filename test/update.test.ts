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

describe("repository updates and optimistic locking", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("passes the current row to updater and writes the updated row", async () => {
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

    const result = await users.update("u1", current => ({
      ...current,
      age: current.age === undefined ? 1 : current.age + 1,
    }));

    expect(result).toEqual({
      id: "u1",
      email: "a@test.com",
      age: 21,
      active: true,
      _version: 2,
    });

    expect(adapter.updatedRows).toEqual([]);
    expect(adapter.updatedRowsByKey).toEqual([
      {
        sheetName: "Users",
        input: {
          expectedHeaders: ["id", "email", "age", "active", "_version"],
          keyHeader: "id",
          versionHeader: "_version",
          updates: [
            {
              id: "u1",
              expectedVersion: 1,
              row: ["u1", "a@test.com", 21, true, 2],
            },
          ],
        },
      },
    ]);
  });

  it("uses sheet header order when writing the updated row", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["_version", "active", "age", "email", "id"],
        rows: [{ rowNumber: 2, cells: [1, true, 20, "a@test.com", "u1"] }],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await users.update("u1", current => ({
      ...current,
      active: false,
    }));

    expect(adapter.updatedRows).toEqual([]);
    expect(adapter.updatedRowsByKey).toEqual([
      {
        sheetName: "Users",
        input: {
          expectedHeaders: ["_version", "active", "age", "email", "id"],
          keyHeader: "id",
          versionHeader: "_version",
          updates: [
            {
              id: "u1",
              expectedVersion: 1,
              row: [2, false, 20, "a@test.com", "u1"],
            },
          ],
        },
      },
    ]);
  });

  it("uses adapter key-based update when available", async () => {
    const sheet = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] }],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });
    adapter.updateRowsByKey = async (sheetName, input) => {
      expect(sheetName).toBe("Users");
      expect(input).toEqual({
        expectedHeaders: ["id", "email", "age", "active", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        updates: [
          {
            id: "u1",
            expectedVersion: 1,
            row: ["u1", "a@test.com", 21, true, 2],
          },
        ],
      });

      return {
        updatedRows: [
          { id: "u1", cells: ["u1", "a@test.com", 21, true, 2] },
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
      users.update("u1", current => ({
        ...current,
        age: 21,
      })),
    ).resolves.toEqual({
      id: "u1",
      email: "a@test.com",
      age: 21,
      active: true,
      _version: 2,
    });
    expect(adapter.readSheets).toEqual(["Users"]);
    expect(adapter.updatedRows).toEqual([]);
  });

  it("runs concurrent key-based updates independently", async () => {
    const sheet = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [
        { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
        { rowNumber: 3, cells: ["u2", "b@test.com", 21, false, 1] },
      ],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });
    const updateRowsByKeyCalls: unknown[] = [];

    adapter.updateRowsByKey = async (sheetName, input) => {
      expect(sheetName).toBe("Users");
      updateRowsByKeyCalls.push(input);

      const update = input.updates[0];

      if (update === undefined) {
        throw new Error("Expected one update");
      }

      return {
        updatedRows: [{ id: update.id, cells: update.row }],
      };
    };

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(
      Promise.all([
        users.update("u1", current => ({
          ...current,
          age: 30,
        })),
        users.update("u2", current => ({
          ...current,
          age: 31,
        })),
      ]),
    ).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        age: 30,
        active: true,
        _version: 2,
      },
      {
        id: "u2",
        email: "b@test.com",
        age: 31,
        active: false,
        _version: 2,
      },
    ]);
    expect(adapter.readSheets).toEqual(["Users", "Users"]);
    expect(adapter.updatedRows).toEqual([]);
    expect(updateRowsByKeyCalls).toEqual([
      {
        expectedHeaders: ["id", "email", "age", "active", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        updates: [
          {
            id: "u1",
            expectedVersion: 1,
            row: ["u1", "a@test.com", 30, true, 2],
          },
        ],
      },
      {
        expectedHeaders: ["id", "email", "age", "active", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        updates: [
          {
            id: "u2",
            expectedVersion: 1,
            row: ["u2", "b@test.com", 31, false, 2],
          },
        ],
      },
    ]);
  });

  it("preserves unknown sheet columns when using key-based update", async () => {
    const sheet = {
      headers: ["id", "notes", "email", "age", "active", "_version"],
      rows: [
        {
          rowNumber: 2,
          cells: ["u1", "keep this note", "a@test.com", 20, true, 1],
        },
      ],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });
    adapter.updateRowsByKey = async (_sheetName, input) => {
      expect(input.updates[0]).toEqual({
        id: "u1",
        expectedVersion: 1,
        row: ["u1", "keep this note", "a@test.com", 21, true, 2],
      });

      return {
        updatedRows: [
          {
            id: "u1",
            cells: ["u1", "keep this note", "a@test.com", 21, true, 2],
          },
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
      users.update("u1", current => ({
        ...current,
        age: 21,
      })),
    ).resolves.toEqual({
      id: "u1",
      email: "a@test.com",
      age: 21,
      active: true,
      _version: 2,
    });
  });

  it("rejects missing key-based update results as conflicts", async () => {
    const sheet = {
      headers: ["id", "email", "age", "active", "_version"],
      rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] }],
    };
    const adapter = new FakeSheetAdapter({
      Users: [sheet, sheet],
    });
    adapter.updateRowsByKey = async () => ({
      updatedRows: [],
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(
      users.update("u1", current => ({
        ...current,
        age: 21,
      })),
    ).rejects.toThrow(ConflictError);
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

    await expect(
      users.update("missing", current => ({
        ...current,
        active: false,
      })),
    ).resolves.toBeNull();

    expect(adapter.updatedRows).toEqual([]);
  });

  it("rejects stale writes when version changes before write", async () => {
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

    await expect(
      users.update("u1", current => ({
        ...current,
        age: 21,
      })),
    ).rejects.toThrow(ConflictError);

    expect(adapter.updatedRows).toEqual([]);
  });
});
