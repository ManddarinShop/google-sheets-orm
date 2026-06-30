import type { SheetAdapter, SheetCell, SheetSnapshot } from "../src/adapter/Adapter.js";

export class FakeSheetAdapter implements SheetAdapter {
  private readIndex = 0;

  readonly appendedRows: Array<{ sheetName: string; row: SheetCell[] }> = [];
  readonly ensuredSheets: string[] = [];
  readonly writtenHeaders: Array<{ sheetName: string; headers: string[] }> = [];
  readonly updatedRows: Array<{
    sheetName: string;
    rowNumber: number;
    row: SheetCell[];
  }> = [];

  constructor(
    private readonly sheets:
      | Record<string, SheetSnapshot>
      | Record<string, SheetSnapshot[]>,
  ) {}

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    const sheetOrSequence = this.sheets[sheetName];
    const sheet = Array.isArray(sheetOrSequence)
      ? sheetOrSequence[
          Math.min(this.readIndex++, sheetOrSequence.length - 1)
        ]
      : sheetOrSequence;

    if (!sheet) {
      throw new Error(`Unknown fake sheet "${sheetName}"`);
    }

    return {
      headers: [...sheet.headers],
      rows: sheet.rows.map(row => ({
        rowNumber: row.rowNumber,
        cells: [...row.cells],
      })),
    };
  }

  async ensureSheet(sheetName: string): Promise<void> {
    this.ensuredSheets.push(sheetName);
  }

  async writeHeader(sheetName: string, headers: string[]): Promise<void> {
    this.writtenHeaders.push({ sheetName, headers: [...headers] });
  }

  async appendRow(sheetName: string, row: SheetCell[]): Promise<void> {
    this.appendedRows.push({ sheetName, row: [...row] });
  }

  async updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void> {
    this.updatedRows.push({ sheetName, rowNumber, row: [...row] });
  }
}
