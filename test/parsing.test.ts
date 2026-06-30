import { describe, expect, it } from "vitest";

import { boolean, number, text } from "../src/core/Columns.js";
import { ParseError } from "../src/core/Errors.js";

describe("columns", () => {
  it("parses text cells", () => {
    expect(text().parse("hello", "name")).toBe("hello");
    expect(text().parse(123, "name")).toBe("123");
    expect(text().parse(true, "name")).toBe("true");
  });

  it("rejects missing required text cells", () => {
    expect(() => text().parse("", "name")).toThrow(ParseError);
    expect(() => text().parse(null, "name")).toThrow(ParseError);
  });

  it("parses number cells", () => {
    expect(number().parse(123, "age")).toBe(123);
    expect(number().parse("123", "age")).toBe(123);
  });

  it("rejects invalid number cells", () => {
    expect(() => number().parse("abc", "age")).toThrow(ParseError);
  });

  it("parses boolean cells", () => {
    expect(boolean().parse(true, "active")).toBe(true);
    expect(boolean().parse(false, "active")).toBe(false);
    expect(boolean().parse("true", "active")).toBe(true);
    expect(boolean().parse("false", "active")).toBe(false);
  });

  it("rejects invalid boolean cells", () => {
    expect(() => boolean().parse("TRUE", "active")).toThrow(ParseError);
    expect(() => boolean().parse("1", "active")).toThrow(ParseError);
    expect(() => boolean().parse("yes", "active")).toThrow(ParseError);
  });

  it("parses optional empty cells as undefined", () => {
    const optionalNumber = number().optional();

    expect(optionalNumber.parse("", "age")).toBeUndefined();
    expect(optionalNumber.parse(null, "age")).toBeUndefined();
  });

  it("serializes undefined optional values as null", () => {
    expect(number().optional().serialize(undefined)).toBeNull();
  });
});
