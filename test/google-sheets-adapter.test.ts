import { describe, expect, it, vi } from "vitest";
import type { sheets_v4 } from "@googleapis/sheets";

import {
  GoogleSheetsAdapter,
  quoteSheetName,
  toA1ColumnName,
  toRowRange,
} from "../src/GoogleSheetsAdapter.js";

describe("Google Sheets adapter helpers", () => {
  it("converts zero-based column indexes to A1 column names", () => {
    expect(toA1ColumnName(0)).toBe("A");
    expect(toA1ColumnName(1)).toBe("B");
    expect(toA1ColumnName(25)).toBe("Z");
    expect(toA1ColumnName(26)).toBe("AA");
    expect(toA1ColumnName(27)).toBe("AB");
    expect(toA1ColumnName(51)).toBe("AZ");
    expect(toA1ColumnName(52)).toBe("BA");
  });

  it("rejects negative column indexes", () => {
    expect(() => toA1ColumnName(-1)).toThrow(RangeError);
  });

  it("leaves simple sheet names unquoted", () => {
    expect(quoteSheetName("Users")).toBe("Users");
    expect(quoteSheetName("Users_2026")).toBe("Users_2026");
  });

  it("quotes sheet names with spaces or special characters", () => {
    expect(quoteSheetName("My Sheet")).toBe("'My Sheet'");
    expect(quoteSheetName("Users-2026")).toBe("'Users-2026'");
  });

  it("escapes single quotes in quoted sheet names", () => {
    expect(quoteSheetName("Owner's Sheet")).toBe("'Owner''s Sheet'");
  });

  it("creates a row range using A1 notation", () => {
    expect(toRowRange("Users", 2, 5)).toBe("Users!A2:E2");
    expect(toRowRange("My Sheet", 10, 3)).toBe("'My Sheet'!A10:C10");
  });

  it("rejects invalid row numbers and cell counts", () => {
    expect(() => toRowRange("Users", 0, 5)).toThrow(RangeError);
    expect(() => toRowRange("Users", 2, 0)).toThrow(RangeError);
    expect(() => toRowRange("Users", 2, -1)).toThrow(RangeError);
  });
});

describe("GoogleSheetsAdapter.readSheet", () => {
  it("reads headers and rows from Google Sheets values", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        values: [
          ["id", "email", "age", "active", "_version"],
          ["u1", "a@test.com", 20, true, 1],
          ["u2", "b@test.com", "", false, 2],
        ],
      },
    });

    const sheetsClient = {
      spreadsheets: {
        values: {
          get,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetId: "spreadsheet-id",
      auth: "unused",
      sheetsClient,
    });

    await expect(adapter.readSheet("Users")).resolves.toEqual({
      headers: ["id", "email", "age", "active", "_version"],
      rows: [
        {
          rowNumber: 2,
          cells: ["u1", "a@test.com", 20, true, 1],
        },
        {
          rowNumber: 3,
          cells: ["u2", "b@test.com", "", false, 2],
        },
      ],
    });

    expect(get).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "Users",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
  });

  it("returns an empty snapshot when the sheet has no values", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {},
    });

    const sheetsClient = {
      spreadsheets: {
        values: {
          get,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetId: "spreadsheet-id",
      auth: "unused",
      sheetsClient,
    });

    await expect(adapter.readSheet("Users")).resolves.toEqual({
      headers: [],
      rows: [],
    });
  });
});

describe("GoogleSheetsAdapter.appendRow", () => {
  it("appends a row using raw value input", async () => {
    const append = vi.fn().mockResolvedValue({
      data: {},
    });

    const sheetsClient = {
      spreadsheets: {
        values: {
          append,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetId: "spreadsheet-id",
      auth: "unused",
      sheetsClient,
    });

    await adapter.appendRow("Users", ["u1", "a@test.com", 20, true, 1]);

    expect(append).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "Users",
      valueInputOption: "RAW",
      requestBody: {
        values: [["u1", "a@test.com", 20, true, 1]],
      },
    });
  });
});

describe("GoogleSheetsAdapter.updateRow", () => {
  it("updates a row using raw value input and A1 range", async () => {
    const update = vi.fn().mockResolvedValue({
      data: {},
    });

    const sheetsClient = {
      spreadsheets: {
        values: {
          update,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetId: "spreadsheet-id",
      auth: "unused",
      sheetsClient,
    });

    await adapter.updateRow("Users", 2, ["u1", "a@test.com", 20, true, 1]);

    expect(update).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "Users!A2:E2",
      valueInputOption: "RAW",
      requestBody: {
        values: [["u1", "a@test.com", 20, true, 1]],
      },
    });
  });

  it("quotes sheet names when updating rows", async () => {
    const update = vi.fn().mockResolvedValue({
      data: {},
    });

    const sheetsClient = {
      spreadsheets: {
        values: {
          update,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetId: "spreadsheet-id",
      auth: "unused",
      sheetsClient,
    });

    await adapter.updateRow("My Sheet", 10, ["u1", "a@test.com", 1]);

    expect(update).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "'My Sheet'!A10:C10",
      valueInputOption: "RAW",
      requestBody: {
        values: [["u1", "a@test.com", 1]],
      },
    });
  });
});
