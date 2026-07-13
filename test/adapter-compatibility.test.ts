import { describe, expect, it } from "vitest";

import type { SheetAdapter } from "../src/adapter/Adapter.js";
import { createSheetRepository } from "../src/core/repository/index.js";
import { number, text } from "../src/core/schema/index.js";

interface User {
  id: string;
  _version: number;
}

describe("adapter type compatibility", () => {
  it("accepts a legacy SheetAdapter in the direct repository factory", () => {
    const adapter: SheetAdapter = {
      readSheet: async () => ({ headers: [], rows: [] }),
      appendRow: async () => undefined,
      updateRow: async () => undefined,
      deleteRow: async () => undefined,
    };

    const repository = createSheetRepository<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns: {
        id: text(),
        _version: number(),
      },
    });

    expect(repository).toBeDefined();
  });
});
