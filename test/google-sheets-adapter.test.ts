import { describe, expect, it, vi } from "vitest";
import type { sheets_v4 } from "@googleapis/sheets";

import {
  extractSpreadsheetId,
  GoogleSheetsAdapter,
  quoteSheetName,
  toA1ColumnName,
  toRowRange,
} from "../src/adapter/GoogleSheetsAdapter.js";

type InitializableGoogleSheetsAdapter = GoogleSheetsAdapter & {
  ensureSheet(sheetName: string): Promise<void>;
  writeHeader(sheetName: string, headers: string[]): Promise<void>;
};

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

  it("quotes simple sheet names", () => {
    expect(quoteSheetName("Users")).toBe("'Users'");
    expect(quoteSheetName("Users_2026")).toBe("'Users_2026'");
  });

  it("quotes sheet names with spaces or special characters", () => {
    expect(quoteSheetName("My Sheet")).toBe("'My Sheet'");
    expect(quoteSheetName("Users-2026")).toBe("'Users-2026'");
  });

  it("escapes single quotes in quoted sheet names", () => {
    expect(quoteSheetName("Owner's Sheet")).toBe("'Owner''s Sheet'");
  });

  it("creates a row range using A1 notation", () => {
    expect(toRowRange("Users", 2, 5)).toBe("'Users'!A2:E2");
    expect(toRowRange("My Sheet", 10, 3)).toBe("'My Sheet'!A10:C10");
  });

  it("rejects invalid row numbers and cell counts", () => {
    expect(() => toRowRange("Users", 0, 5)).toThrow(RangeError);
    expect(() => toRowRange("Users", 2, 0)).toThrow(RangeError);
    expect(() => toRowRange("Users", 2, -1)).toThrow(RangeError);
  });

  it("extracts a spreadsheet id from a Google Sheets URL", () => {
    expect(
      extractSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
      ),
    ).toBe("spreadsheet-id");
  });

  it("rejects non-Google-Sheets URLs when extracting spreadsheet ids", () => {
    expect(() => extractSpreadsheetId("https://example.com/not-a-sheet")).toThrow(
      /Invalid Google Sheets URL/,
    );
  });
});

describe("GoogleSheetsAdapter.readSheet", () => {
  it("accepts a Google Sheets URL instead of a raw spreadsheet id", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        values: [["id"]],
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
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit?gid=0#gid=0",
      auth: "unused",
      sheetsClient,
    });

    await adapter.readSheet("Users");

    expect(get).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "'Users'!A:ZZ",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
  });

  it("rejects invalid Google Sheets URLs", () => {
    expect(
      () =>
        new GoogleSheetsAdapter({
          spreadsheetUrl: "https://example.com/not-a-google-sheet",
          auth: "unused",
          sheetsClient: {} as sheets_v4.Sheets,
        }),
    ).toThrow(/Invalid Google Sheets URL/);
  });

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
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
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
      range: "'Users'!A:ZZ",
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
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
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
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
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
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    });

    await adapter.updateRow("Users", 2, ["u1", "a@test.com", 20, true, 1]);

    expect(update).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "'Users'!A2:E2",
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
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
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

describe("GoogleSheetsAdapter.deleteRow", () => {
  it("deletes a data row using a dimension request", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "Users", sheetId: 123 } }],
      },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });

    const sheetsClient = {
      spreadsheets: {
        get,
        batchUpdate,
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    });

    await adapter.deleteRow("Users", 3);

    expect(get).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      fields: "sheets.properties.sheetId,sheets.properties.title",
    });
    expect(batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 123,
                dimension: "ROWS",
                startIndex: 2,
                endIndex: 3,
              },
            },
          },
        ],
      },
    });
  });

  it("caches sheet ids for repeated row deletes", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "Users", sheetId: 123 } }],
      },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });

    const sheetsClient = {
      spreadsheets: {
        get,
        batchUpdate,
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    });

    await adapter.deleteRow("Users", 3);
    await adapter.deleteRow("Users", 4);

    expect(get).toHaveBeenCalledTimes(1);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
  });

  it("rejects header row deletion", async () => {
    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient: {} as sheets_v4.Sheets,
    });

    await expect(adapter.deleteRow("Users", 1)).rejects.toThrow(RangeError);
  });
});

describe("GoogleSheetsAdapter.ensureSheet", () => {
  it("does not create a sheet tab when the tab already exists", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "Users" } }],
      },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });

    const sheetsClient = {
      spreadsheets: {
        get,
        batchUpdate,
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    }) as InitializableGoogleSheetsAdapter;

    await adapter.ensureSheet("Users");

    expect(get).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      fields: "sheets.properties.sheetId,sheets.properties.title",
    });
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("creates a sheet tab when the tab is missing", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "Orders" } }],
      },
    });
    const batchUpdate = vi.fn().mockResolvedValue({
      data: {
        replies: [{ addSheet: { properties: { sheetId: 456 } } }],
      },
    });

    const sheetsClient = {
      spreadsheets: {
        get,
        batchUpdate,
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    }) as InitializableGoogleSheetsAdapter;

    await adapter.ensureSheet("Users");

    expect(batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: "Users",
              },
            },
          },
        ],
      },
    });
  });

  it("rejects missing sheet ids from the create response", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "Orders" } }],
      },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });

    const sheetsClient = {
      spreadsheets: {
        get,
        batchUpdate,
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    }) as InitializableGoogleSheetsAdapter;

    await expect(adapter.ensureSheet("Users")).rejects.toThrow(
      /Google Sheets API did not return sheetId for Users/,
    );
  });
});

describe("GoogleSheetsAdapter.writeHeader", () => {
  it("writes headers to the first row using raw value input", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });

    const sheetsClient = {
      spreadsheets: {
        values: {
          update,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    }) as InitializableGoogleSheetsAdapter;

    await adapter.writeHeader("Users", ["id", "email", "age", "active", "_version"]);

    expect(update).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "'Users'!A1:E1",
      valueInputOption: "RAW",
      requestBody: {
        values: [["id", "email", "age", "active", "_version"]],
      },
    });
  });

  it("quotes sheet names when writing headers", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });

    const sheetsClient = {
      spreadsheets: {
        values: {
          update,
        },
      },
    } as unknown as sheets_v4.Sheets;

    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit",
      auth: "unused",
      sheetsClient,
    }) as InitializableGoogleSheetsAdapter;

    await adapter.writeHeader("My Sheet", ["id", "email"]);

    expect(update).toHaveBeenCalledWith({
      spreadsheetId: "spreadsheet-id",
      range: "'My Sheet'!A1:B1",
      valueInputOption: "RAW",
      requestBody: {
        values: [["id", "email"]],
      },
    });
  });
});
