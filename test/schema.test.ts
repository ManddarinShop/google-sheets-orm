import { describe, expect, it } from "vitest";

import { text, number, boolean } from "../src/Columns.js";
import { SchemaDriftError } from "../src/Errors.js";
import { assertSchema } from "../src/Schema.js";

describe("schema drift validation", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  it("passes when all declared columns are present", () => {
    expect(() =>
      assertSchema({
        headers: ["id", "email", "age", "active", "_version"],
        key: "id",
        columns,
      }),
    ).not.toThrow();
  });

  it("fails when a required column is missing", () => {
    expect(() =>
      assertSchema({
        headers: ["id", "email", "age", "_version"],
        key: "id",
        columns,
      }),
    ).toThrow(SchemaDriftError);
  });

  it("fails when the key column is missing", () => {
    expect(() =>
      assertSchema({
        headers: ["email", "age", "active", "_version"],
        key: "id",
        columns,
      }),
    ).toThrow(SchemaDriftError);
  });

  it("fails when the version column is missing", () => {
    expect(() =>
      assertSchema({
        headers: ["id", "email", "age", "active"],
        key: "id",
        columns,
      }),
    ).toThrow(SchemaDriftError);
  });

  it("fails when headers are duplicated", () => {
    expect(() =>
      assertSchema({
        headers: ["id", "email", "email", "age", "active", "_version"],
        key: "id",
        columns,
      }),
    ).toThrow(SchemaDriftError);
  });

  it("allows extra columns by default", () => {
    expect(() =>
      assertSchema({
        headers: ["id", "email", "age", "active", "_version", "notes"],
        key: "id",
        columns,
      }),
    ).not.toThrow();
  });
});
