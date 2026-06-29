import { describe, expect, it } from "vitest";

import {
  ConflictError,
  ParseError,
  SchemaDriftError,
  boolean,
  createSheetRepository,
  number,
  text,
} from "../src/index.js";

describe("public API", () => {
  it("exports repository factory, column factories, and public errors", () => {
    expect(createSheetRepository).toBeTypeOf("function");
    expect(text).toBeTypeOf("function");
    expect(number).toBeTypeOf("function");
    expect(boolean).toBeTypeOf("function");
    expect(SchemaDriftError).toBeTypeOf("function");
    expect(ParseError).toBeTypeOf("function");
    expect(ConflictError).toBeTypeOf("function");
  });
});
