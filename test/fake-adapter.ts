import type { SheetAdapter, SheetCell, SheetSnapshot } from "../src/Adapter.js";

export class FakeSheetAdapter implements SheetAdapter {
  private readIndex = 0;

  readonly appendedRows: Array<{ sheetName: string; row: SheetCell[] }> = [];
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
