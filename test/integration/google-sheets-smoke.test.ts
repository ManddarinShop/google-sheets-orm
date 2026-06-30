import { describe, expect, it } from "vitest";

import { boolean, createSheetRepository, number, text } from "../../src/index.js";
import { GoogleSheetsAdapter } from "../../src/GoogleSheetsAdapter.js";

interface SmokeUser {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

const spreadsheetUrl = process.env.GOOGLE_SPREADSHEET_URL;
const sheetName = process.env.GOOGLE_SHEET_NAME ?? "Users";
const shouldRun = Boolean(spreadsheetUrl);
const describeIntegration = shouldRun ? describe : describe.skip;

describeIntegration("Google Sheets smoke test", () => {
  it("reads, inserts, finds, and updates a row through the repository", async () => {
    const adapter = new GoogleSheetsAdapter({
      spreadsheetUrl: spreadsheetUrl!,
    });

    const users = createSheetRepository<SmokeUser>({
      adapter,
      sheetName,
      key: "id",
      columns: {
        id: text(),
        email: text(),
        age: number().optional(),
        active: boolean(),
        _version: number(),
      },
    });

    const id = `smoke-${Date.now()}`;

    await users.ensureSheet();

    await users.insert({
      id,
      email: `${id}@example.com`,
      age: undefined,
      active: true,
      _version: 1,
    });

    await expect(users.findById(id)).resolves.toEqual({
      id,
      email: `${id}@example.com`,
      age: undefined,
      active: true,
      _version: 1,
    });

    await expect(
      users.update(id, current => ({
        ...current,
        age: 42,
      })),
    ).resolves.toEqual({
      id,
      email: `${id}@example.com`,
      age: 42,
      active: true,
      _version: 2,
    });

    await expect(users.findById(id)).resolves.toMatchObject({
      id,
      age: 42,
      _version: 2,
    });
  }, 30_000);
});
