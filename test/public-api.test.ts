import { describe, expect, it } from "vitest";

import {
  ConflictError,
  GoogleSheetsAdapter,
  ParseError,
  SchemaDriftError,
  boolean,
  createSheetRepository,
  loadTypedSheetsConfig,
  number,
  parseTypedSheetsConfig,
  runSetup,
  text,
  writeTypedSheetsConfig,
} from "../src/index.js";

describe("public API", () => {
  it("exports repository factory, column factories, adapter, and public errors", () => {
    expect(createSheetRepository).toBeTypeOf("function");
    expect(text).toBeTypeOf("function");
    expect(number).toBeTypeOf("function");
    expect(boolean).toBeTypeOf("function");
    expect(SchemaDriftError).toBeTypeOf("function");
    expect(ParseError).toBeTypeOf("function");
    expect(ConflictError).toBeTypeOf("function");
    expect(GoogleSheetsAdapter).toBeTypeOf("function");
    expect(parseTypedSheetsConfig).toBeTypeOf("function");
    expect(loadTypedSheetsConfig).toBeTypeOf("function");
    expect(writeTypedSheetsConfig).toBeTypeOf("function");
    expect(runSetup).toBeTypeOf("function");
  });

  it("exposes sheet initialization methods on the Google Sheets adapter", () => {
    expect(GoogleSheetsAdapter.prototype.ensureSheet).toBeTypeOf("function");
    expect(GoogleSheetsAdapter.prototype.writeHeader).toBeTypeOf("function");
  });
});
