import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/core/Columns.js";
import { ParseError } from "../src/core/Errors.js";
import { parseRow } from "../src/core/RowParser.js";

describe("row parser", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("parses sheet cells into a typed object using header order", () => {
    expect(
      parseRow({
        headers: ["id", "email", "age", "active", "_version"],
        cells: ["u1", "a@test.com", "20", "true", 1],
        columns,
      }),
    ).toEqual({
      id: "u1",
      email: "a@test.com",
      age: 20,
      active: true,
      _version: 1,
    });
  });

  it("parses optional empty cells as undefined", () => {
    expect(
      parseRow({
        headers: ["id", "email", "age", "active", "_version"],
        cells: ["u1", "a@test.com", "", false, 1],
        columns,
      }),
    ).toEqual({
      id: "u1",
      email: "a@test.com",
      age: undefined,
      active: false,
      _version: 1,
    });
  });

  it("rejects missing required cells", () => {
    expect(() =>
      parseRow({
        headers: ["id", "email", "age", "active", "_version"],
        cells: ["u1", "", 20, true, 1],
        columns,
      }),
    ).toThrow(ParseError);
  });

  it("rejects invalid number cells", () => {
    expect(() =>
      parseRow({
        headers: ["id", "email", "age", "active", "_version"],
        cells: ["u1", "a@test.com", "not-a-number", true, 1],
        columns,
      }),
    ).toThrow(ParseError);
  });

  it("rejects invalid boolean cells", () => {
    expect(() =>
      parseRow({
        headers: ["id", "email", "age", "active", "_version"],
        cells: ["u1", "a@test.com", 20, "yes", 1],
        columns,
      }),
    ).toThrow(ParseError);
  });

  it("ignores extra sheet columns that are not declared in schema", () => {
    expect(
      parseRow({
        headers: ["id", "email", "age", "active", "_version", "notes"],
        cells: ["u1", "a@test.com", 20, true, 1, "internal memo"],
        columns,
      }),
    ).toEqual({
      id: "u1",
      email: "a@test.com",
      age: 20,
      active: true,
      _version: 1,
    });
  });
});
