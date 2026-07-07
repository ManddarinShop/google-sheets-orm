import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/core/Columns.js";
import { createSheetRepository } from "../src/core/Repository.js";
import { FakeSheetAdapter } from "./fake-adapter.js";

interface User {
  id: string;
  email: string;
  age: number;
  active: boolean;
  _version: number;
}

describe("repository write batcher", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number(),
    active: boolean(),
    _version: number(),
  };

  it("keeps mixed same-tick writes in enqueue order", async () => {
    const headers = ["id", "email", "age", "active", "_version"];
    const initialRows = [
      { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
      { rowNumber: 3, cells: ["u2", "b@test.com", 21, false, 1] },
    ];
    const rowsAfterInsert = [
      ...initialRows,
      { rowNumber: 4, cells: ["u3", "c@test.com", 22, true, 1] },
    ];
    const adapter = new FakeSheetAdapter({
      Users: [
        { headers, rows: initialRows },
        { headers, rows: rowsAfterInsert },
        { headers, rows: rowsAfterInsert },
      ],
    });
    const operations: string[] = [];
    const appendRows = adapter.appendRows.bind(adapter);

    adapter.appendRows = async (sheetName, input) => {
      operations.push("appendRows");
      await appendRows(sheetName, input);
    };
    adapter.updateRowsByKey = async () => {
      operations.push("updateRowsByKey");

      return {
        updatedRows: [
          { id: "u1", cells: ["u1", "a@test.com", 30, true, 2] },
        ],
      };
    };
    adapter.deleteRowsByKey = async () => {
      operations.push("deleteRowsByKey");

      return {
        deletedRows: [
          { id: "u2", cells: ["u2", "b@test.com", 21, false, 1] },
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
      Promise.all([
        users.insert({
          id: "u3",
          email: "c@test.com",
          age: 22,
          active: true,
          _version: 1,
        }),
        users.update("u1", (current) => ({
          ...current,
          age: 30,
        })),
        users.deleteById("u2"),
      ]),
    ).resolves.toEqual([
      undefined,
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
        age: 21,
        active: false,
        _version: 1,
      },
    ]);

    expect(operations).toEqual([
      "appendRows",
      "updateRowsByKey",
      "deleteRowsByKey",
    ]);
  });
});
