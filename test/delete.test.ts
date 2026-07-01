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
    expect(adapter.deletedRows).toEqual([
      {
        sheetName: "Users",
        rowNumber: 2,
      },
    ]);
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
