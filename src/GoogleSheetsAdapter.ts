import { sheets, type sheets_v4 } from "@googleapis/sheets";
import type { SheetAdapter, SheetCell, SheetSnapshot } from "./Adapter.js";

export interface GoogleSheetsAdapterOptions {
  spreadsheetId: string;
  auth: unknown;
  sheetsClient?: sheets_v4.Sheets;
}


export class GoogleSheetsAdapter implements SheetAdapter {
  private readonly sheetsClient: sheets_v4.Sheets;
  private readonly spreadsheetId: string;

  constructor(options: GoogleSheetsAdapterOptions) {
    this.spreadsheetId = options.spreadsheetId;
    this.sheetsClient = options.sheetsClient ?? sheets({ version: "v4", auth: options.auth as any });
  }

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    const response = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetName,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const values = response.data.values ?? [];
    const headerRow = values[0] ?? [];
    const dataRows = values.slice(1);

    return {
      headers: headerRow.map(value => String(value)),
      rows: dataRows.map((cells, index) => ({
        rowNumber: index + 2,
        cells: cells.map(toSheetCell)
      }))
    };


  }
  async appendRow(sheetName: string, row: SheetCell[]): Promise<void> {
    await this.sheetsClient.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: sheetName,
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      }
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
  if (/^[A-Za-z0-9_]+$/.test(sheetName)) {
    return sheetName;
  }

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
