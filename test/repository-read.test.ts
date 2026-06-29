import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/Columns.js";
import { SchemaDriftError } from "../src/Errors.js";
import { createSheetRepository } from "../src/Repository.js";
import { FakeSheetAdapter } from "./fake-adapter.js";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

describe("repository reads", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("findAll returns typed rows from a sheet snapshot", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email", "age", "active", "_version"],
        rows: [
          { rowNumber: 2, cells: ["u1", "a@test.com", "20", "true", 1] },
          { rowNumber: 3, cells: ["u2", "b@test.com", "", false, 2] },
        ],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(users.findAll()).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      },
      {
        id: "u2",
        email: "b@test.com",
        age: undefined,
        active: false,
        _version: 2,
      },
    ]);
  });

  it("findById returns the matching typed row", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email", "age", "active", "_version"],
        rows: [
          { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
          { rowNumber: 3, cells: ["u2", "b@test.com", 30, false, 1] },
        ],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(users.findById("u2")).resolves.toEqual({
      id: "u2",
      email: "b@test.com",
      age: 30,
      active: false,
      _version: 1,
    });
  });

  it("findById returns null when the key is not found", async () => {
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

    await expect(users.findById("missing")).resolves.toBeNull();
  });

  it("fails when duplicate keys exist in the sheet", async () => {
    const adapter = new FakeSheetAdapter({
      Users: {
        headers: ["id", "email", "age", "active", "_version"],
        rows: [
          { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
          { rowNumber: 3, cells: ["u1", "duplicate@test.com", 30, false, 1] },
        ],
      },
    });

    const users = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
    });

    await expect(users.findAll()).rejects.toThrow(SchemaDriftError);
  });
});
