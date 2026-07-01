import { auth as googleAuth, sheets, type sheets_v4 } from "@googleapis/sheets";
import type { SheetAdapter, SheetCell, SheetSnapshot } from "./Adapter.js";

type GoogleSheetsAuth = NonNullable<sheets_v4.Options["auth"]>;

export interface GoogleSheetsAdapterOptions {
  spreadsheetUrl: string;
  auth?: GoogleSheetsAuth;
  sheetsClient?: sheets_v4.Sheets;
}

export class GoogleSheetsAdapter implements SheetAdapter {
  private readonly sheetsClient: sheets_v4.Sheets;
  private readonly spreadsheetId: string;
  private readonly sheetIdCache = new Map<string, number>();

  constructor(options: GoogleSheetsAdapterOptions) {
    const auth =
      options.auth ??
      new googleAuth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

    this.spreadsheetId = extractSpreadsheetId(options.spreadsheetUrl);
    this.sheetsClient = options.sheetsClient ?? sheets({ version: "v4", auth });
  }

  async ensureSheet(sheetName: string): Promise<void> {
    const response = await this.sheetsClient.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties.sheetId,sheets.properties.title",
    });

    const sheets = response.data.sheets ?? [];
    const existingSheet = sheets.find(
      (sheet) => sheet.properties?.title === sheetName,
    );
    const existingSheetId = existingSheet?.properties?.sheetId;

    if (existingSheet) {
      if (typeof existingSheetId === "number") {
        this.sheetIdCache.set(sheetName, existingSheetId);
      }
      return;
    }

    const responseAfterCreate = await this.sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          },
        ],
      },
    });
    this.sheetIdCache.set(
      sheetName,
      requireCreatedSheetId(responseAfterCreate.data, sheetName),
    );
  }

  async writeHeader(sheetName: string, headers: string[]): Promise<void> {
    await this.sheetsClient.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: toRowRange(sheetName, 1, headers.length),
      valueInputOption: "RAW",
      requestBody: {
        values: [headers],
      },
    });
  }

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    const response = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(sheetName)}!A:ZZ`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const values = response.data.values ?? [];
    const headerRow = values[0] ?? [];
    const dataRows = values.slice(1);

    return {
      headers: headerRow.map((value) => String(value)),
      rows: dataRows.map((cells, index) => ({
        rowNumber: index + 2,
        cells: cells.map(toSheetCell),
      })),
    };
  }
  async appendRow(sheetName: string, row: SheetCell[]): Promise<void> {
    await this.sheetsClient.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: sheetName,
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      },
    });
  }

  async updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void> {
    await this.sheetsClient.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: toRowRange(sheetName, rowNumber, row.length),
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      },
    });
  }

  // Deletes a physical Google Sheets row; repository-level locking happens
  // before this adapter method is called.
  async deleteRow(sheetName: string, rowNumber: number): Promise<void> {
    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new RangeError(`Invalid data row number "${rowNumber}"`);
    }

    const sheetId = await this.getSheetId(sheetName);

    await this.sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: rowNumber - 1,
                endIndex: rowNumber,
              },
            },
          },
        ],
      },
    });
  }

  // Google batchUpdate needs a numeric sheetId, so cache the lookup by tab name
  // for the adapter lifetime to avoid an extra API call on repeated deletes.
  private async getSheetId(sheetName: string): Promise<number> {
    const cached = this.sheetIdCache.get(sheetName);

    if (cached !== undefined) {
      return cached;
    }

    const response = await this.sheetsClient.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties.sheetId,sheets.properties.title",
    });

    const sheetId = requireSheetIdForName(response.data, sheetName);

    this.sheetIdCache.set(sheetName, sheetId);

    return sheetId;
  }
}

function requireCreatedSheetId(
  response: sheets_v4.Schema$BatchUpdateSpreadsheetResponse,
  sheetName: string,
): number {
  const sheetId = response.replies?.[0]?.addSheet?.properties?.sheetId;

  if (typeof sheetId !== "number") {
    throw new Error(`Google Sheets API did not return sheetId for ${sheetName}`);
  }

  return sheetId;
}

function requireSheetIdForName(
  response: sheets_v4.Schema$Spreadsheet,
  sheetName: string,
): number {
  const sheet = (response.sheets ?? []).find(
    (candidate) => candidate.properties?.title === sheetName,
  );
  const sheetId = sheet?.properties?.sheetId;

  if (typeof sheetId !== "number") {
    throw new Error(`Sheet not found: ${sheetName}`);
  }

  return sheetId;
}

export function toA1ColumnName(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Invalid column index "${index}"`);
  }

  let current = index + 1;
  let columnName = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    columnName = String.fromCharCode(65 + remainder) + columnName;
    current = Math.floor((current - 1) / 26);
  }

  return columnName;
}

export function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replaceAll("'", "''")}'`;
}

export function toRowRange(
  sheetName: string,
  rowNumber: number,
  cellCount: number,
): string {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new RangeError(`Invalid row number "${rowNumber}"`);
  }

  if (!Number.isInteger(cellCount) || cellCount < 1) {
    throw new RangeError(`Invalid cell count "${cellCount}"`);
  }

  const startColumn = toA1ColumnName(0);
  const endColumn = toA1ColumnName(cellCount - 1);
  const quotedSheetName = quoteSheetName(sheetName);

  return `${quotedSheetName}!${startColumn}${rowNumber}:${endColumn}${rowNumber}`;
}

export function extractSpreadsheetId(url: string): string {
  const match = url.match(
    /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)(?:\/|$)/,
  );

  if (!match?.[1]) {
    throw new Error("Invalid Google Sheets URL");
  }

  return match[1];
}

function toSheetCell(value: unknown): SheetCell {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}
