import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface GatewayTemplate {
  TYPED_SHEETS_TASK_QUEUE_HEADERS: string[];
  TYPED_SHEETS_TASK_QUEUE_SHEET_NAME: string;
  TYPED_SHEETS_MAX_QUEUE_ATTEMPTS: number;
  createCanonicalSheetName_(
    logicalSheetName: string,
    hash: string,
    collisionIndex: number,
  ): string;
  createShortHash_(value: string): string;
  getGatewayUrl_(existingConfig: {
    auth?: {
      gatewayUrl?: string;
    };
  } | null): string;
  enqueueTasks_(
    spreadsheet: FakeSpreadsheet,
    request: {
      tasks: Array<{
        taskId: string;
        transactionId: string;
        transactionIndex: number;
        operation: "insert" | "update" | "delete";
        sheetName: string;
        keyHeader: string;
        keyValue: string;
        expectedVersion: number | null;
        payloadJson: string;
      }>;
    },
  ): {
    ok: true;
    tasks: Array<{
      taskId: string;
      sequence: number;
    }>;
  };
  processTaskQueue_(
    spreadsheet: FakeSpreadsheet,
    request: { maxTransactions?: number },
  ): {
    ok: true;
    processedTransactions: number;
    failedTransactions: number;
    processedTasks: number;
    failedTasks: number;
    remainingPendingTasks: number;
    recoveryPendingTasks?: number;
  };
  readCanonicalSheet_(
    spreadsheet: FakeSpreadsheet,
    request: { sheetName: string },
  ): {
    ok: true;
    headers: string[];
    rows: Array<{ rowNumber: number; cells: unknown[] }>;
  };
  initializeSystemSheets_(
    spreadsheet: FakeSpreadsheet,
    request: { sheetName: string; headers: string[] },
  ): {
    logicalSheetName: string;
    canonicalSheetName: string;
    projectionSheetName: string;
    taskQueueSheetName: string;
  };
  ensureMetaSheet_(
    spreadsheet: FakeSpreadsheet,
    config: {
      spreadsheetUrl: string;
      defaultSheetName: string;
      auth: { gatewayUrl: string; type: string };
    },
  ): void;
}

interface FakeSetValuesInput {
  sheetName: string;
  row: number;
  column: number;
  rowCount: number;
  columnCount: number;
  values: unknown[][];
}

interface FakeSpreadsheetOptions {
  protectThrows?: boolean;
  failSetValues?(input: FakeSetValuesInput): Error | null;
}

class FakeSpreadsheet {
  readonly insertedSheetNames: string[] = [];
  readonly sheets = new Map<string, FakeSheet>();

  constructor(private readonly options: FakeSpreadsheetOptions = {}) {}

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(name, this.options);

    this.sheets.set(name, sheet);
    this.insertedSheetNames.push(name);

    return sheet;
  }
}

class FakeSheet {
  readonly name: string;
  hideCalls = 0;
  protectCalls = 0;
  protectionDescriptions: string[] = [];
  warningOnlyValues: boolean[] = [];
  removedEditors: string[][] = [];
  domainEditValues: boolean[] = [];
  clearCalls = 0;
  readonly setValuesCalls: Array<{
    row: number;
    column: number;
    rowCount: number;
    columnCount: number;
  }> = [];
  clearContentRanges: Array<{
    row: number;
    column: number;
    rowCount: number;
    columnCount: number;
  }> = [];
  values: unknown[][] = [];

  constructor(
    name: string,
    private readonly options: FakeSpreadsheetOptions = {},
  ) {
    this.name = name;
  }

  getSetValuesFailure(input: Omit<FakeSetValuesInput, "sheetName">): Error | null {
    return this.options.failSetValues?.({
      ...input,
      sheetName: this.name,
    }) ?? null;
  }

  getRange(
    row: number,
    column: number,
    rowCount: number,
    columnCount: number,
  ): FakeRange {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  getLastColumn(): number {
    return Math.max(0, ...this.values.map((row) => row.length));
  }

  getLastRow(): number {
    return this.values.length;
  }

  hideSheet(): void {
    this.hideCalls += 1;
  }

  protect(): FakeProtection {
    this.protectCalls += 1;

    if (this.options.protectThrows) {
      throw new Error("protection denied");
    }

    return new FakeProtection(this);
  }

  clear(): void {
    this.clearCalls += 1;
    this.values = [];
  }
}

class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly column: number,
    private readonly rowCount: number,
    private readonly columnCount: number,
  ) {}

  getValues(): unknown[][] {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => {
      const sourceRow = this.sheet.values[this.row - 1 + rowOffset] ?? [];

      return Array.from({ length: this.columnCount }, (_, columnOffset) => {
        return sourceRow[this.column - 1 + columnOffset] ?? "";
      });
    });
  }

  setValues(values: unknown[][]): void {
    this.sheet.setValuesCalls.push({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
    });

    const failure = this.sheet.getSetValuesFailure({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
      values,
    });

    if (failure !== null) {
      throw failure;
    }

    values.forEach((sourceRow, rowOffset) => {
      const targetRowIndex = this.row - 1 + rowOffset;
      const targetRow = this.sheet.values[targetRowIndex] ?? [];

      sourceRow.forEach((value, columnOffset) => {
        targetRow[this.column - 1 + columnOffset] = value;
      });

      this.sheet.values[targetRowIndex] = targetRow;
    });
  }

  clearContent(): void {
    this.sheet.clearContentRanges.push({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
    });

    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const targetRowIndex = this.row - 1 + rowOffset;
      const targetRow = this.sheet.values[targetRowIndex] ?? [];

      for (
        let columnOffset = 0;
        columnOffset < this.columnCount;
        columnOffset += 1
      ) {
        targetRow[this.column - 1 + columnOffset] = "";
      }

      this.sheet.values[targetRowIndex] = targetRow;
    }
  }
}

class FakeProtection {
  constructor(private readonly sheet: FakeSheet) {}

  setDescription(description: string): void {
    this.sheet.protectionDescriptions.push(description);
  }

  setWarningOnly(value: boolean): void {
    this.sheet.warningOnlyValues.push(value);
  }

  getEditors(): string[] {
    return ["editor@example.com"];
  }

  removeEditors(editors: string[]): void {
    this.sheet.removedEditors.push(editors);
  }

  canDomainEdit(): boolean {
    return true;
  }

  setDomainEdit(value: boolean): void {
    this.sheet.domainEditValues.push(value);
  }
}

describe("manual Apps Script gateway template system sheets", () => {
  async function readGatewayCode(): Promise<string> {
    return readFile("templates/manual-apps-script-gateway/Code.gs", "utf8");
  }

  async function loadGatewayTemplate(logs: string[] = []): Promise<GatewayTemplate> {
    const code = await readGatewayCode();
    const createTemplate = new Function(
      "Logger",
      "Utilities",
      [
        code,
        "return {",
        "  TYPED_SHEETS_TASK_QUEUE_HEADERS,",
        "  TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,",
        "  TYPED_SHEETS_MAX_QUEUE_ATTEMPTS,",
        "  createCanonicalSheetName_,",
        "  createShortHash_,",
        "  getGatewayUrl_,",
        "  enqueueTasks_,",
        "  processTaskQueue_,",
        "  readCanonicalSheet_,",
        "  initializeSystemSheets_,",
        "  ensureMetaSheet_,",
        "};",
      ].join("\n"),
    );

    return createTemplate({
      log(message: string) {
        logs.push(message);
      },
    }, {
      DigestAlgorithm: {
        SHA_256: "SHA_256",
      },
      computeDigest(_algorithm: string, value: string) {
        return Array.from(createHash("sha256").update(value).digest())
          .map((byte) => (byte > 127 ? byte - 256 : byte));
      },
    }) as GatewayTemplate;
  }

  it("does not block setup completion with an alert after logging config", async () => {
    const code = await readGatewayCode();

    expect(code).not.toContain("SpreadsheetApp.getUi()");
    expect(code).not.toContain(".toast(");
    expect(code).toContain("Logger.log(configJson)");
    expect(code).toContain('const TYPED_SHEETS_GATEWAY_URL = ""');
    expect(code).not.toContain("ScriptApp.getService().getUrl()");
  });

  it("does not add a custom Google Sheets menu on open", async () => {
    const code = await readGatewayCode();

    expect(code).not.toContain("function onOpen()");
    expect(code).not.toContain(".createMenu(");
  });

  it("creates bounded canonical names with a deterministic suffix", async () => {
    const gateway = await loadGatewayTemplate();
    const longName = "Users".repeat(40);
    const canonicalSheetName = gateway.createCanonicalSheetName_(
      longName,
      gateway.createShortHash_(longName),
      0,
    );

    expect(canonicalSheetName).toMatch(/^_typed_sheets_data_/);
    expect(canonicalSheetName.length).toBeLessThanOrEqual(100);
  });

  it("reuses an existing stored gateway URL when the manual URL constant is empty", async () => {
    const gateway = await loadGatewayTemplate();

    expect(
      gateway.getGatewayUrl_({
        auth: {
          gatewayUrl:
            "https://script.google.com/macros/s/deployment-id/exec",
        },
      }),
    ).toBe("https://script.google.com/macros/s/deployment-id/exec");
  });

  it("creates visible projection plus hidden protected canonical and task queue sheets", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    const result = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "active", "_version"],
    });

    expect(result).toEqual({
      logicalSheetName: "Users",
      canonicalSheetName: gateway.createCanonicalSheetName_(
        "Users",
        gateway.createShortHash_("Users"),
        0,
      ),
      projectionSheetName: "Users",
      taskQueueSheetName: "_typed_sheets_task_queue",
    });
    const canonicalSheetName = result.canonicalSheetName;

    expect(spreadsheet.insertedSheetNames).toEqual([
      "_typed_sheets_meta",
      "Users",
      canonicalSheetName,
      "_typed_sheets_task_queue",
    ]);

    const projection = spreadsheet.sheets.get("Users");
    const canonical = spreadsheet.sheets.get(canonicalSheetName);
    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(projection?.values[0]).toEqual(["id", "email", "active", "_version"]);
    expect(projection?.hideCalls).toBe(0);
    expect(projection?.protectCalls).toBe(0);
    expect(canonical?.values[0]).toEqual(["id", "email", "active", "_version"]);
    expect(queue?.values[0]).toEqual(gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS);
    expect(queue?.values[0]).toEqual([
      "taskId",
      "transactionId",
      "transactionIndex",
      "sequence",
      "status",
      "operation",
      "sheetName",
      "keyHeader",
      "keyValue",
      "expectedVersion",
      "payloadJson",
      "attempts",
      "lastErrorCode",
      "lastErrorMessage",
      "createdAt",
      "updatedAt",
      "taskFingerprint",
    ]);
    expect(gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME).toBe(
      "_typed_sheets_task_queue",
    );
    expect(canonical?.hideCalls).toBe(1);
    expect(queue?.hideCalls).toBe(1);
    expect(canonical?.protectCalls).toBe(1);
    expect(queue?.protectCalls).toBe(1);
    expect(canonical?.protectionDescriptions).toEqual([
      "typed-sheets internal sheet: " + canonicalSheetName,
    ]);
    expect(canonical?.warningOnlyValues).toEqual([false]);
    expect(canonical?.removedEditors).toEqual([["editor@example.com"]]);
    expect(queue?.domainEditValues).toEqual([false]);

    const meta = spreadsheet.sheets.get("_typed_sheets_meta");
    expect(meta?.values[1]).toEqual([
      "sheetMapping:Users",
      JSON.stringify({
        logicalSheetName: "Users",
        canonicalSheetName,
        projectionSheetName: "Users",
      }),
    ]);
  });

  it("migrates a legacy 16-column task queue and preserves pending work", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const task = {
      taskId: "task-legacy-1",
      transactionId: "tx-legacy-1",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({
        row: {
          id: "u1",
          email: "legacy@test.com",
          _version: 1,
        },
      }),
    };
    const legacyQueue = spreadsheet.insertSheet("_typed_sheets_task_queue");
    legacyQueue.values = [
      gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS.slice(0, -1),
      [
        task.taskId,
        task.transactionId,
        task.transactionIndex,
        1,
        "pending",
        task.operation,
        task.sheetName,
        task.keyHeader,
        task.keyValue,
        "",
        task.payloadJson,
        0,
        "",
        "",
        "2026-07-11T00:00:00.000Z",
        "2026-07-11T00:00:00.000Z",
      ],
    ];

    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });

    expect(legacyQueue.values[0]).toEqual(
      gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS,
    );
    expect(legacyQueue.values[1]?.slice(0, 16)).toEqual([
      task.taskId,
      task.transactionId,
      task.transactionIndex,
      1,
      "pending",
      task.operation,
      task.sheetName,
      task.keyHeader,
      task.keyValue,
      "",
      task.payloadJson,
      0,
      "",
      "",
      "2026-07-11T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z",
    ]);
    expect(legacyQueue.values[1]?.[16]).toEqual(expect.any(String));

    expect(
      gateway.enqueueTasks_(spreadsheet, { tasks: [task] }),
    ).toEqual({
      ok: true,
      tasks: [{ taskId: task.taskId, sequence: 1 }],
    });
    expect(legacyQueue.values).toHaveLength(2);

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 1,
      processedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(
      spreadsheet.sheets.get(systemSheets.canonicalSheetName)?.values,
    ).toEqual([
      ["id", "email", "_version"],
      ["u1", "legacy@test.com", 1],
    ]);
  });

  it("migrates existing projection rows and reads queued state from canonical", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const projection = spreadsheet.insertSheet("Users");
    projection.values = [
      ["id", "email", "_version"],
      ["u1", "legacy@test.com", 1],
    ];

    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "legacy@test.com", 1],
    ]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-migrated-update",
          transactionId: "tx-migrated-update",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: {
              id: "u1",
              email: "queued@test.com",
              _version: 2,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 1,
      processedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(
      gateway.readCanonicalSheet_(spreadsheet, { sheetName: "Users" }),
    ).toEqual({
      ok: true,
      headers: ["id", "email", "_version"],
      rows: [
        {
          rowNumber: 2,
          cells: ["u1", "queued@test.com", 2],
        },
      ],
    });
    expect(projection.values[1]).toEqual(["u1", "legacy@test.com", 1]);
  });

  it("does not re-import stale projection rows after a queued delete", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const projection = spreadsheet.insertSheet("Users");
    projection.values = [
      ["id", "email", "_version"],
      ["u1", "legacy@test.com", 1],
    ];

    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (canonical === undefined || queue === undefined) {
      throw new Error("Expected canonical and task queue sheets");
    }

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-delete-migrated-row",
          transactionId: "tx-delete-migrated-row",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            rowToDelete: {
              id: "u1",
              email: "legacy@test.com",
              _version: 1,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 1,
      processedTasks: 1,
      remainingPendingTasks: 0,
    });
    const canonicalAfterDelete = canonical.values.map((row) => [...row]);

    gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });

    expect(canonical.values).toEqual(canonicalAfterDelete);
    expect(canonical.values).not.toContainEqual([
      "u1",
      "legacy@test.com",
      1,
    ]);
  });

  it("preserves migration metadata when setup rewrites the meta sheet", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const projection = spreadsheet.insertSheet("Users");
    projection.values = [
      ["id", "email", "_version"],
      ["u1", "legacy@test.com", 1],
    ];

    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (canonical === undefined || queue === undefined) {
      throw new Error("Expected canonical and task queue sheets");
    }

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-delete-before-setup",
          transactionId: "tx-delete-before-setup",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            rowToDelete: {
              id: "u1",
              email: "legacy@test.com",
              _version: 1,
            },
          }),
        },
      ],
    });
    gateway.processTaskQueue_(spreadsheet, {});

    gateway.ensureMetaSheet_(spreadsheet, {
      spreadsheetUrl: "https://spreadsheet.example",
      defaultSheetName: "Users",
      auth: {
        gatewayUrl: "https://gateway.example/exec",
        type: "apps-script-gateway",
      },
    });
    gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });

    expect(canonical.values).not.toContainEqual([
      "u1",
      "legacy@test.com",
      1,
    ]);
    expect(
      spreadsheet.sheets.get("_typed_sheets_meta")?.values.some(
        (row) => row[0] === "projectionMigration:Users",
      ),
    ).toBe(true);
  });

  it("rejects projection schema drift during queued initialization", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const projection = spreadsheet.insertSheet("Users");
    projection.values = [
      ["id", "wrong", "_version"],
    ];

    expect(() =>
      gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "Users",
        headers: ["id", "email", "_version"],
      }),
    ).toThrow("Header row changed before projection initialization");
  });

  it("rejects duplicate projection headers during queued initialization", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const projection = spreadsheet.insertSheet("Users");
    projection.values = [
      ["id", "email", "email", "_version"],
    ];

    expect(() =>
      gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "Users",
        headers: ["id", "email", "active", "_version"],
      }),
    ).toThrow("Duplicate header before projection initialization: email");
  });

  it("rejects duplicate requested headers before creating queued sheets", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    expect(() =>
      gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "Users",
        headers: ["id", "email", "email"],
      }),
    ).toThrow("Duplicate header before projection initialization: email");
    expect(spreadsheet.sheets.has("Users")).toBe(false);
  });

  it("rejects canonical schema drift during queued initialization", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    if (canonical === undefined) {
      throw new Error("Expected canonical sheet");
    }

    canonical.values[0] = ["id", "wrong", "_version"];

    expect(() =>
      gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "Users",
        headers: ["id", "email", "_version"],
      }),
    ).toThrow("Header row changed before canonical initialization");
  });

  it("keeps redacted legacy done tasks replayable by task id", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const task = {
      taskId: "task-legacy-done",
      transactionId: "tx-legacy-done",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
    };
    const legacyQueue = spreadsheet.insertSheet("_typed_sheets_task_queue");
    legacyQueue.values = [
      gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS.slice(0, -1),
      [
        task.taskId,
        task.transactionId,
        task.transactionIndex,
        1,
        "done",
        task.operation,
        task.sheetName,
        task.keyHeader,
        task.keyValue,
        "",
        JSON.stringify({ redacted: true }),
        1,
        "",
        "",
        "2026-07-11T00:00:00.000Z",
        "2026-07-11T00:00:00.000Z",
      ],
    ];

    gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });

    expect(
      gateway.enqueueTasks_(spreadsheet, { tasks: [task] }),
    ).toEqual({
      ok: true,
      tasks: [{ taskId: task.taskId, sequence: 1 }],
    });
    expect(legacyQueue.values).toHaveLength(2);
    expect(legacyQueue.values[1]?.[16]).toBe(
      "legacy-redacted:" + task.taskId,
    );
  });

  it("resumes fingerprint migration for a 17-column redacted queue row", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const task = {
      taskId: "task-partial-migration",
      transactionId: "tx-partial-migration",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
    };
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    gateway.enqueueTasks_(spreadsheet, { tasks: [task] });
    queue.values[1]![4] = "done";
    queue.values[1]![10] = JSON.stringify({ redacted: true });
    queue.values[1]![16] = "";

    expect(gateway.enqueueTasks_(spreadsheet, { tasks: [task] })).toEqual({
      ok: true,
      tasks: [{ taskId: task.taskId, sequence: 1 }],
    });
    expect(queue.values[1]?.[16]).toBe(
      "legacy-redacted:" + task.taskId,
    );
    expect(spreadsheet.sheets.get(systemSheets.canonicalSheetName)?.values).toEqual([
      ["id", "_version"],
    ]);
  });

  it("does not recreate or overwrite existing system sheets", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });

    const firstMapping = JSON.parse(
      String(spreadsheet.sheets.get("_typed_sheets_meta")?.values[1]?.[1]),
    ) as { canonicalSheetName: string };
    const canonical = spreadsheet.sheets.get(firstMapping.canonicalSheetName);
    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    canonical?.values.push(["u1", "a@test.com", 1]);
    queue?.values.push(["task-1"]);

    gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });

    expect(spreadsheet.insertedSheetNames).toEqual([
      "_typed_sheets_meta",
      "Users",
      firstMapping.canonicalSheetName,
      "_typed_sheets_task_queue",
    ]);
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);
    expect(queue?.values[1]).toEqual(["task-1"]);
    expect(canonical?.hideCalls).toBe(2);
    expect(queue?.protectCalls).toBe(2);
  });

  it("appends pending tasks to the hidden task queue with gateway-assigned sequences", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const firstResult = gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: {
              id: "u1",
              email: "a@test.com",
              _version: 1,
            },
          }),
        },
        {
          taskId: "task-2",
          transactionId: "tx-1",
          transactionIndex: 1,
          operation: "update",
          sheetName: "Orders",
          keyHeader: "id",
          keyValue: "o1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: {
              id: "o1",
              total: 20,
              _version: 2,
            },
          }),
        },
      ],
    });
    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    // A queue migration can leave a blank fingerprint until the next enqueue.
    // The hot path repairs only that cell instead of rewriting the full
    // fingerprint column or re-protecting the sheet.
    const firstTaskFingerprint = queue.values[1]![16];
    queue.values[1]![16] = "";
    queue.setValuesCalls.length = 0;

    const secondResult = gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-3",
          transactionId: "tx-2",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: 2,
          payloadJson: JSON.stringify({
            expectedVersion: 2,
            rowToDelete: {
              id: "u2",
              email: "b@test.com",
              _version: 2,
            },
          }),
        },
      ],
    });

    expect(firstResult).toEqual({
      ok: true,
      tasks: [
        { taskId: "task-1", sequence: 1 },
        { taskId: "task-2", sequence: 2 },
      ],
    });
    expect(secondResult).toEqual({
      ok: true,
      tasks: [{ taskId: "task-3", sequence: 3 }],
    });

    expect(queue?.values[0]).toEqual(gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS);
    expect(queue?.hideCalls).toBe(1);
    expect(queue?.protectCalls).toBe(1);
    expect(queue.values[1]?.[16]).toBe(firstTaskFingerprint);
    expect(queue.setValuesCalls).toEqual([
      {
        row: 2,
        column: 17,
        rowCount: 1,
        columnCount: 1,
      },
      {
        row: 4,
        column: 1,
        rowCount: 1,
        columnCount: gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS.length,
      },
    ]);
    expect(queue?.values.slice(1)).toEqual([
      [
        "task-1",
        "tx-1",
        0,
        1,
        "pending",
        "insert",
        "Users",
        "id",
        "u1",
        "",
        JSON.stringify({
          row: {
            id: "u1",
            email: "a@test.com",
            _version: 1,
          },
        }),
        0,
        "",
        "",
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
      [
        "task-2",
        "tx-1",
        1,
        2,
        "pending",
        "update",
        "Orders",
        "id",
        "o1",
        1,
        JSON.stringify({
          expectedVersion: 1,
          rowToWrite: {
            id: "o1",
            total: 20,
            _version: 2,
          },
        }),
        0,
        "",
        "",
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
      [
        "task-3",
        "tx-2",
        0,
        3,
        "pending",
        "delete",
        "Users",
        "id",
        "u2",
        2,
        JSON.stringify({
          expectedVersion: 2,
          rowToDelete: {
            id: "u2",
            email: "b@test.com",
            _version: 2,
          },
        }),
        0,
        "",
        "",
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
    ]);
  });

  it("returns existing queued tasks for idempotent task id replays", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const task = {
      taskId: "task-1",
      transactionId: "tx-1",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
    };

    expect(
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [task],
      }),
    ).toEqual({
      ok: true,
      tasks: [{ taskId: "task-1", sequence: 1 }],
    });

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");
    if (queue) {
      queue.values[1]![4] = "done";
      queue.values[1]![10] = JSON.stringify({ redacted: true });
    }

    expect(
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [task],
      }),
    ).toEqual({
      ok: true,
      tasks: [{ taskId: "task-1", sequence: 1 }],
    });

    expect(queue?.values).toHaveLength(2);
    expect(queue?.values[1]?.[16]).toEqual(expect.any(String));
  });

  it("rejects new tasks appended to a terminal transaction", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const firstTask = {
      taskId: "task-terminal-1",
      transactionId: "tx-terminal",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
    };

    gateway.enqueueTasks_(spreadsheet, { tasks: [firstTask] });
    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![4] = "done";
    queue.values[1]![10] = JSON.stringify({ redacted: true });

    expect(() =>
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [
          {
            taskId: "task-terminal-2",
            transactionId: "tx-terminal",
            transactionIndex: 1,
            operation: "insert",
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u2",
            expectedVersion: null,
            payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
          },
        ],
      }),
    ).toThrow(/Transaction already contains terminal tasks: tx-terminal/);
    expect(queue.values).toHaveLength(2);
  });

  it("rejects duplicate task ids with a different payload", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const task = {
      taskId: "task-1",
      transactionId: "tx-1",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
    };

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [task],
    });

    expect(() =>
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [
          {
            ...task,
            payloadJson: JSON.stringify({ row: { id: "u1", _version: 2 } }),
          },
        ],
      }),
    ).toThrow(/Task already exists: task-1/);
  });

  it("rejects queue payload tampering when the stored fingerprint is unchanged", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const task = {
      taskId: "task-tampered",
      transactionId: "tx-tampered",
      transactionIndex: 0,
      operation: "insert" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
    };

    gateway.enqueueTasks_(spreadsheet, { tasks: [task] });
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![10] = JSON.stringify({ row: { id: "u1", _version: 2 } });

    expect(() =>
      gateway.enqueueTasks_(spreadsheet, { tasks: [task] }),
    ).toThrow(/Task fingerprint mismatch: task-tampered/);
    expect(() =>
      gateway.processTaskQueue_(spreadsheet, {}),
    ).toThrow(/Task fingerprint mismatch: task-tampered/);
  });

  it("rejects queued insert tasks with a numeric expected version", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    expect(() =>
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [
          {
            taskId: "task-1",
            transactionId: "tx-1",
            transactionIndex: 0,
            operation: "insert",
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            expectedVersion: 1,
            payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
          },
        ],
      }),
    ).toThrow(/expectedVersion must be null or blank for insert tasks/);
  });

  it("rejects queued update and delete tasks without numeric expected versions", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const updateTask = {
      taskId: "task-1",
      transactionId: "tx-1",
      transactionIndex: 0,
      operation: "update" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u1",
      expectedVersion: null,
      payloadJson: JSON.stringify({
        expectedVersion: 1,
        rowToWrite: { id: "u1", _version: 2 },
      }),
    };
    const deleteTask = {
      taskId: "task-2",
      transactionId: "tx-2",
      transactionIndex: 0,
      operation: "delete" as const,
      sheetName: "Users",
      keyHeader: "id",
      keyValue: "u2",
      expectedVersion: null,
      payloadJson: JSON.stringify({
        expectedVersion: 1,
        rowToDelete: { id: "u2", _version: 1 },
      }),
    };

    expect(() =>
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [updateTask],
      }),
    ).toThrow(/expectedVersion must be a number/);
    expect(() =>
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [deleteTask],
      }),
    ).toThrow(/expectedVersion must be a number/);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-numeric", "not-a-number"],
    ["false", false],
    ["true", true],
    ["numeric string zero", "0"],
    ["numeric string one", "1"],
  ] as const)("rejects queue rows with %s attempts", async (_label, attempts) => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-invalid-attempts",
          transactionId: "tx-invalid-attempts",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", _version: 1 },
          }),
        },
      ],
    });

    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![11] = attempts;

    expect(() => gateway.processTaskQueue_(spreadsheet, {})).toThrow(
      /Invalid attempts at queue row 2/,
    );
    expect(queue.values[1]![4]).toBe("pending");
  });

  it("rejects queued tasks with string transaction indexes", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    expect(() =>
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [
          {
            taskId: "task-1",
            transactionId: "tx-1",
            transactionIndex: "0" as unknown as number,
            operation: "insert",
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            expectedVersion: null,
            payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
          },
        ],
      }),
    ).toThrow(/transactionIndex must be a non-negative integer/);
  });

  it("processes pending queue tasks into the canonical sheet", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "active", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(
      ["u2", "old@test.com", false, 1],
      ["u3", "delete@test.com", true, 2],
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: {
              id: "u1",
              email: "a@test.com",
              active: true,
              _version: 1,
            },
          }),
        },
        {
          taskId: "task-2",
          transactionId: "tx-1",
          transactionIndex: 1,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: {
              id: "u2",
              email: "new@test.com",
              active: true,
              _version: 2,
            },
          }),
        },
        {
          taskId: "task-3",
          transactionId: "tx-1",
          transactionIndex: 2,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u3",
          expectedVersion: 2,
          payloadJson: JSON.stringify({
            expectedVersion: 2,
            rowToDelete: {
              id: "u3",
              email: "delete@test.com",
              active: true,
              _version: 2,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 3,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "active", "_version"],
      ["u2", "new@test.com", true, 2],
      ["u1", "a@test.com", true, 1],
    ]);
    expect(canonical?.clearCalls).toBe(0);
    expect(canonical?.clearContentRanges).toEqual([]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(queue?.values.slice(1).map((row) => row[10])).toEqual([
      JSON.stringify({ redacted: true }),
      JSON.stringify({ redacted: true }),
      JSON.stringify({ redacted: true }),
    ]);
  });

  it("keeps a transaction recoverable when completion status recording fails", async () => {
    const queueSheetName = "_typed_sheets_task_queue";
    let statusFailureInjected = false;
    const spreadsheet = new FakeSpreadsheet({
      failSetValues: ({ sheetName, column, values }) => {
        if (
          !statusFailureInjected
          && sheetName === queueSheetName
          && column === 5
          && values[0]?.[0] === "done"
        ) {
          statusFailureInjected = true;
          return new Error("queue status write lost");
        }

        return null;
      },
    });
    const gateway = await loadGatewayTemplate();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const queue = spreadsheet.sheets.get(queueSheetName);
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-status-recovery",
          transactionId: "tx-status-recovery",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
      ],
    });

    if (queue === undefined || canonical === undefined) {
      throw new Error("Expected queue and canonical sheets");
    }

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
      remainingPendingTasks: 0,
      recoveryPendingTasks: 1,
    });
    expect(canonical.values).toEqual([
      ["id", "_version"],
      ["u1", 1],
    ]);
    expect(queue.values[1]?.[4]).toBe("processing");
    expect(queue.values[1]?.[12]).toBe("completion_status_unconfirmed");

    queue.values[1]![15] = "2020-01-01T00:00:00.000Z";

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 1,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(queue.values[1]?.[4]).toBe("done");
  });

  it("retries payload redaction after completion status was recorded", async () => {
    const queueSheetName = "_typed_sheets_task_queue";
    let redactionFailureInjected = false;
    const spreadsheet = new FakeSpreadsheet({
      failSetValues: ({ sheetName, column, values }) => {
        if (
          !redactionFailureInjected
          && sheetName === queueSheetName
          && column === 11
          && values[0]?.[0] === JSON.stringify({ redacted: true })
        ) {
          redactionFailureInjected = true;
          return new Error("queue payload redaction lost");
        }

        return null;
      },
    });
    const gateway = await loadGatewayTemplate();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const queue = spreadsheet.sheets.get(queueSheetName);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-redaction-retry",
          transactionId: "tx-redaction-retry",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected queue sheet");
    }

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
      recoveryPendingTasks: 1,
    });
    expect(queue.values[1]?.[4]).toBe("done");
    expect(queue.values[1]?.[10]).toBe(
      JSON.stringify({ row: { id: "u1", _version: 1 } }),
    );
    expect(queue.values[1]?.[12]).toBe("completion_status_unconfirmed");

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
    });
    expect(queue.values[1]?.[10]).toBe(
      JSON.stringify({ redacted: true }),
    );
  });

  it("stops later pending transactions after an unconfirmed canonical write", async () => {
    let failNextCanonicalWrite = false;
    let canonicalSheetName = "";
    const spreadsheet = new FakeSpreadsheet({
      failSetValues: ({ sheetName }) => {
        if (failNextCanonicalWrite && sheetName === canonicalSheetName) {
          failNextCanonicalWrite = false;
          return new Error("canonical write outcome lost");
        }

        return null;
      },
    });
    const gateway = await loadGatewayTemplate();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    canonicalSheetName = systemSheets.canonicalSheetName;
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-unconfirmed-first",
          transactionId: "tx-unconfirmed-first",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
        {
          taskId: "task-blocked-second",
          transactionId: "tx-blocked-second",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    failNextCanonicalWrite = true;

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
      remainingPendingTasks: 1,
      recoveryPendingTasks: 1,
    });
    expect(
      spreadsheet.sheets.get(canonicalSheetName)?.values,
    ).toEqual([["id", "_version"]]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "processing",
      "pending",
    ]);
  });

  it("keeps a cross-sheet partial apply recoverable until postconditions are checked", async () => {
    let failCanonicalWrite = false;
    let secondCanonicalSheetName = "";
    const spreadsheet = new FakeSpreadsheet({
      failSetValues: ({ sheetName }) => {
        if (failCanonicalWrite && sheetName === secondCanonicalSheetName) {
          return new Error("second canonical write failed");
        }

        return null;
      },
    });
    const gateway = await loadGatewayTemplate();
    const firstSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "AUsers",
      headers: ["id", "_version"],
    });
    const secondSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "ZOrders",
      headers: ["id", "_version"],
    });
    secondCanonicalSheetName = secondSheets.canonicalSheetName;
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-cross-sheet-users",
          transactionId: "tx-cross-sheet-partial",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "AUsers",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
        {
          taskId: "task-cross-sheet-order",
          transactionId: "tx-cross-sheet-partial",
          transactionIndex: 1,
          operation: "insert",
          sheetName: "ZOrders",
          keyHeader: "id",
          keyValue: "o1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "o1", _version: 1 } }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected queue sheet");
    }

    failCanonicalWrite = true;
    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(
      spreadsheet.sheets.get(firstSheets.canonicalSheetName)?.values,
    ).toEqual([
      ["id", "_version"],
      ["u1", 1],
    ]);
    expect(
      spreadsheet.sheets.get(secondSheets.canonicalSheetName)?.values,
    ).toEqual([["id", "_version"]]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "processing",
      "processing",
    ]);
    expect(queue.values.slice(1).map((row) => row[12])).toEqual([
      "canonical_write_unconfirmed",
      "canonical_write_unconfirmed",
    ]);

    failCanonicalWrite = false;
    queue.values.slice(1).forEach((row) => {
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 2,
      remainingPendingTasks: 0,
    });
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "failed",
      "failed",
    ]);
    expect(queue.values.slice(1).map((row) => row[12])).toEqual([
      "partial_apply",
      "partial_apply",
    ]);
  });

  it("rejects queue writes when a canonical modeled header drifts", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (canonical === undefined || queue === undefined) {
      throw new Error("Expected canonical and queue sheets");
    }

    canonical.values[0] = ["id", "wrong", "_version"];
    canonical.values.push(["u1", "old@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-schema-drift-update",
          transactionId: "tx-schema-drift-update",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: {
              id: "u1",
              email: "new@test.com",
              _version: 2,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical.values).toEqual([
      ["id", "wrong", "_version"],
      ["u1", "old@test.com", 1],
    ]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual(["failed"]);
    expect(queue.values.slice(1).map((row) => row[12])).toEqual([
      "schema_drift",
    ]);
  });

  it("rejects mixed key headers within one sheet transaction", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    canonical?.values.push(
      ["u1", "a@test.com", 1],
      ["u2", "b@test.com", 1],
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-consistent-key",
          transactionId: "tx-mixed-key",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u1", email: "new@test.com", _version: 2 },
          }),
        },
        {
          taskId: "task-mixed-key",
          transactionId: "tx-mixed-key",
          transactionIndex: 1,
          operation: "update",
          sheetName: "Users",
          keyHeader: "email",
          keyValue: "u2",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u2", email: "wrong@test.com", _version: 2 },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 2,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
      ["u2", "b@test.com", 1],
    ]);
    expect(queue?.values.slice(1).map((row) => row[4])).toEqual([
      "failed",
      "failed",
    ]);
    expect(queue?.values.slice(1).map((row) => row[12])).toEqual([
      "schema_drift",
      "schema_drift",
    ]);
  });

  it("marks a failed transaction without mutating the canonical sheet", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", "a@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 99,
          payloadJson: JSON.stringify({
            expectedVersion: 99,
            rowToWrite: {
              id: "u1",
              email: "stale@test.com",
              _version: 100,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");
    const taskRow = queue?.values[1];

    expect(taskRow?.[4]).toBe("failed");
    expect(taskRow?.[12]).toBe("conflict");
    expect(taskRow?.[13]).toMatch(/Stale task/);
  });

  it("fails a transaction when the payload key does not match the queued key", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([["id", "_version"]]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[1]?.[4]).toBe("failed");
    expect(queue?.values[1]?.[12]).toBe("invalid_task");
  });

  it.each([
    ["missing", { id: "u1" }],
    ["null", { id: "u1", _version: null }],
  ])(
    "rejects insert payloads with a %s _version before canonical mutation",
    async (_caseName, row) => {
      const gateway = await loadGatewayTemplate();
      const spreadsheet = new FakeSpreadsheet();
      const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "Users",
        headers: ["id", "_version"],
      });
      const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

      gateway.enqueueTasks_(spreadsheet, {
        tasks: [
          {
            taskId: "task-invalid-insert-version",
            transactionId: "tx-invalid-insert-version",
            transactionIndex: 0,
            operation: "insert",
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            expectedVersion: null,
            payloadJson: JSON.stringify({ row }),
          },
        ],
      });

      expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
        ok: true,
        processedTransactions: 0,
        failedTransactions: 1,
        processedTasks: 0,
        failedTasks: 1,
        remainingPendingTasks: 0,
      });
      expect(canonical?.values).toEqual([["id", "_version"]]);

      const queue = spreadsheet.sheets.get(
        gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
      );

      expect(queue?.values[1]?.[4]).toBe("failed");
      expect(queue?.values[1]?.[12]).toBe("invalid_task");
      expect(queue?.values[1]?.[13]).toMatch(
        /payload\.row\._version must be a number/,
      );
    },
  );

  it("fails update tasks that do not advance the row version", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", "a@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: {
              id: "u1",
              email: "new@test.com",
              _version: 1,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[1]?.[4]).toBe("failed");
    expect(queue?.values[1]?.[12]).toBe("invalid_task");
    expect(queue?.values[1]?.[13]).toMatch(/must advance expectedVersion/);
  });

  it("fails update tasks with a missing rowToWrite version", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", "a@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: {
              id: "u1",
              email: "new@test.com",
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[1]?.[4]).toBe("failed");
    expect(queue?.values[1]?.[12]).toBe("invalid_task");
    expect(queue?.values[1]?.[13]).toMatch(/payload.rowToWrite._version/);
  });

  it("fails delete tasks with a missing rowToDelete payload", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", "a@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[1]?.[4]).toBe("failed");
    expect(queue?.values[1]?.[12]).toBe("invalid_task");
    expect(queue?.values[1]?.[13]).toMatch(/payload.rowToDelete/);
  });

  it("fails delete tasks when rowToDelete mismatches the queued key", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", "a@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToDelete: {
              id: "u2",
              email: "a@test.com",
              _version: 1,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[1]?.[4]).toBe("failed");
    expect(queue?.values[1]?.[12]).toBe("invalid_task");
    expect(queue?.values[1]?.[13]).toMatch(/rowToDelete key/);
  });

  it("fails delete tasks when rowToDelete mismatches expectedVersion", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", "a@test.com", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToDelete: {
              id: "u1",
              email: "a@test.com",
              _version: 2,
            },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "email", "_version"],
      ["u1", "a@test.com", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[1]?.[4]).toBe("failed");
    expect(queue?.values[1]?.[12]).toBe("invalid_task");
    expect(queue?.values[1]?.[13]).toMatch(/rowToDelete._version/);
  });

  it("clears only trailing canonical rows after replacement rows are written", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    canonical?.values.push(["u1", 1], ["u2", 1]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToDelete: { id: "u2", _version: 1 },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 1,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "_version"],
      ["u1", 1],
      ["", ""],
    ]);
    expect(canonical?.clearCalls).toBe(0);
    expect(canonical?.clearContentRanges).toEqual([
      { row: 3, column: 1, rowCount: 1, columnCount: 2 },
    ]);
  });

  it("processes at most the requested number of transaction groups", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
        {
          taskId: "task-2",
          transactionId: "tx-2",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
        },
      ],
    });

    expect(
      gateway.processTaskQueue_(spreadsheet, { maxTransactions: 1 }),
    ).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 1,
      failedTasks: 0,
      remainingPendingTasks: 1,
    });
    expect(canonical?.values).toEqual([
      ["id", "_version"],
      ["u1", 1],
    ]);

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "pending",
    ]);
  });

  it("appends insert-only canonical rows without rewriting the table", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-append-1",
          transactionId: "tx-append",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", _version: 1 },
          }),
        },
        {
          taskId: "task-append-2",
          transactionId: "tx-append",
          transactionIndex: 1,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u2", _version: 1 },
          }),
        },
      ],
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 1,
      processedTasks: 2,
      failedTransactions: 0,
      failedTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "_version"],
      ["u1", 1],
      ["u2", 1],
    ]);
    expect(canonical?.clearContentRanges).toEqual([]);
    expect(canonical?.setValuesCalls.filter((call) => call.row > 1)).toEqual([
      {
        row: 2,
        column: 1,
        rowCount: 2,
        columnCount: 2,
      },
    ]);

    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );
    const queueStatusWrites = queue?.setValuesCalls.filter(
      (call) => call.row > 1,
    );

    expect(queueStatusWrites).toHaveLength(9);
    expect(queueStatusWrites?.every((call) => call.rowCount === 2)).toBe(true);
  });

  it("holds incomplete pending transaction groups", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
        {
          taskId: "task-2",
          transactionId: "tx-1",
          transactionIndex: 1,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
        },
      ],
    });

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");
    if (queue) {
      queue.values[1]![4] = "done";
    }

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
      remainingPendingTasks: 1,
    });
    expect(canonical?.values).toEqual([["id", "_version"]]);
    expect(queue?.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "pending",
    ]);
  });

  it("recovers stale processing tasks after an interrupted processor run", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-interrupted",
          transactionId: "tx-interrupted",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", _version: 1 },
          }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![4] = "processing";
    queue.values[1]![11] = 1;
    queue.values[1]![15] = "2020-01-01T00:00:00.000Z";

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 1,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(
      spreadsheet.sheets.get(systemSheets.canonicalSheetName)?.values,
    ).toEqual([
      ["id", "_version"],
      ["u1", 1],
    ]);
    expect(queue.values[1]![4]).toBe("done");
    expect(queue.values[1]![11]).toBe(2);
  });

  it("dead-letters an unapplied stale transaction after the retry limit", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-retry-limit",
          transactionId: "tx-retry-limit",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected queue sheet");
    }

    queue.values[1]![4] = "processing";
    queue.values[1]![11] = gateway.TYPED_SHEETS_MAX_QUEUE_ATTEMPTS;
    queue.values[1]![15] = "2020-01-01T00:00:00.000Z";

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(
      spreadsheet.sheets.get(systemSheets.canonicalSheetName)?.values,
    ).toEqual([["id", "_version"]]);
    expect(queue.values[1]?.[4]).toBe("failed");
    expect(queue.values[1]?.[12]).toBe("retry_limit_exceeded");
  });

  it("blocks a later pending transaction behind a fresh processing transaction", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-order-insert",
          transactionId: "tx-order-insert",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", name: "old", _version: 1 },
          }),
        },
        {
          taskId: "task-order-update",
          transactionId: "tx-order-update",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u1", name: "new", _version: 2 },
          }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![4] = "processing";
    queue.values[1]![15] = new Date().toISOString();

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 0,
      processedTasks: 0,
      failedTasks: 0,
      remainingPendingTasks: 1,
      recoveryPendingTasks: 1,
    });
    expect(canonical?.values).toEqual([
      ["id", "name", "_version"],
    ]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "processing",
      "pending",
    ]);
  });

  it("reconciles a stale insert followed by an update as one final state", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-chain-insert",
          transactionId: "tx-chain-insert-update",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", name: "old", _version: 1 },
          }),
        },
        {
          taskId: "task-chain-update",
          transactionId: "tx-chain-insert-update",
          transactionIndex: 1,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u1", name: "new", _version: 2 },
          }),
        },
      ],
    });

    canonical?.values.push(["u1", "new", 2]);

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 2,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "done",
    ]);
  });

  it("retries an unapplied insert followed by an update from the initial state", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-unapplied-insert",
          transactionId: "tx-unapplied-insert-update",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", name: "old", _version: 1 },
          }),
        },
        {
          taskId: "task-unapplied-update",
          transactionId: "tx-unapplied-insert-update",
          transactionIndex: 1,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u1", name: "new", _version: 2 },
          }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 2,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "name", "_version"],
      ["u1", "new", 2],
    ]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "done",
    ]);
  });

  it("fails an insert followed by delete when an intermediate row remains", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    canonical?.values.push(["u1", "old", 1]);
    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-intermediate-insert",
          transactionId: "tx-intermediate-insert-delete",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", name: "old", _version: 1 },
          }),
        },
        {
          taskId: "task-intermediate-delete",
          transactionId: "tx-intermediate-insert-delete",
          transactionIndex: 1,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToDelete: { id: "u1", name: "old", _version: 1 },
          }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 2,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "name", "_version"],
      ["u1", "old", 1],
    ]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "failed",
      "failed",
    ]);
    expect(queue.values.slice(1).map((row) => row[12])).toEqual([
      "partial_apply",
      "partial_apply",
    ]);
  });

  it("retries a stale update followed by a delete when canonical state is initial", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-chain-update",
          transactionId: "tx-chain-update-delete",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u1", name: "new", _version: 2 },
          }),
        },
        {
          taskId: "task-chain-delete",
          transactionId: "tx-chain-update-delete",
          transactionIndex: 1,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 2,
          payloadJson: JSON.stringify({
            expectedVersion: 2,
            rowToDelete: { id: "u1", name: "new", _version: 2 },
          }),
        },
      ],
    });

    canonical?.values.push(["u1", "old", 1]);

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 2,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "name", "_version"],
      ["", "", ""],
    ]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "done",
    ]);
  });

  it("fails a stale update followed by a delete when canonical state is empty", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-empty-chain-update",
          transactionId: "tx-empty-chain-update-delete",
          transactionIndex: 0,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToWrite: { id: "u1", name: "new", _version: 2 },
          }),
        },
        {
          taskId: "task-empty-chain-delete",
          transactionId: "tx-empty-chain-update-delete",
          transactionIndex: 1,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 2,
          payloadJson: JSON.stringify({
            expectedVersion: 2,
            rowToDelete: { id: "u1", name: "new", _version: 2 },
          }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 2,
      remainingPendingTasks: 0,
    });
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "failed",
      "failed",
    ]);
    expect(queue.values.slice(1).map((row) => row[12])).toEqual([
      "partial_apply",
      "partial_apply",
    ]);
  });

  it("reconciles a stale delete followed by an insert as one final state", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-chain-delete",
          transactionId: "tx-chain-delete-insert",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            expectedVersion: 1,
            rowToDelete: { id: "u1", name: "old", _version: 1 },
          }),
        },
        {
          taskId: "task-chain-insert",
          transactionId: "tx-chain-delete-insert",
          transactionIndex: 1,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: { id: "u1", name: "new", _version: 1 },
          }),
        },
      ],
    });

    canonical?.values.push(["u1", "new", 1]);

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 2,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(canonical?.values).toEqual([
      ["id", "name", "_version"],
      ["u1", "new", 1],
    ]);
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "done",
    ]);
  });

  it("reconciles a stale transaction after all canonical rows were applied", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-recovered-done-1",
          transactionId: "tx-recovered-done",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
        {
          taskId: "task-recovered-done-2",
          transactionId: "tx-recovered-done",
          transactionIndex: 1,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
        },
      ],
    });

    canonical?.values.push(["u1", 1], ["u2", 1]);

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![4] = "done";
    queue.values[1]![10] = JSON.stringify({ redacted: true });
    queue.values[2]![4] = "processing";
    queue.values[2]![15] = "2020-01-01T00:00:00.000Z";

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 2,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "done",
      "done",
    ]);
    expect(canonical?.values).toEqual([
      ["id", "_version"],
      ["u1", 1],
      ["u2", 1],
    ]);
  });

  it("fails a stale transaction when only part of its canonical state was applied", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-partial-1",
          transactionId: "tx-partial",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u1", _version: 1 } }),
        },
        {
          taskId: "task-partial-2",
          transactionId: "tx-partial",
          transactionIndex: 1,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: null,
          payloadJson: JSON.stringify({ row: { id: "u2", _version: 1 } }),
        },
      ],
    });

    canonical?.values.push(["u1", 1]);

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values.slice(1).forEach((row) => {
      row[4] = "processing";
      row[15] = "2020-01-01T00:00:00.000Z";
    });

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 2,
      remainingPendingTasks: 0,
    });
    expect(queue.values.slice(1).map((row) => row[4])).toEqual([
      "failed",
      "failed",
    ]);
    expect(queue.values.slice(1).map((row) => row[12])).toEqual([
      "partial_apply",
      "partial_apply",
    ]);
    expect(canonical?.values).toEqual([
      ["id", "_version"],
      ["u1", 1],
    ]);
  });

  it("fails stale deletes when the missing row cannot prove the postcondition", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-delete-ambiguous",
          transactionId: "tx-delete-ambiguous",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            rowToDelete: { id: "u1", _version: 1 },
          }),
        },
      ],
    });

    if (queue === undefined) {
      throw new Error("Expected task queue sheet");
    }

    queue.values[1]![4] = "processing";
    queue.values[1]![15] = "2020-01-01T00:00:00.000Z";

    expect(gateway.processTaskQueue_(spreadsheet, {})).toEqual({
      ok: true,
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 1,
      remainingPendingTasks: 0,
    });
    expect(queue.values[1]![4]).toBe("failed");
    expect(queue.values[1]![12]).toBe("partial_apply");
  });

  it("retries a stale delete with unmodeled canonical columns", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const systemSheets = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "name", "_version"],
    });
    const canonical = spreadsheet.sheets.get(systemSheets.canonicalSheetName);
    const queue = spreadsheet.sheets.get(
      gateway.TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    );

    if (canonical === undefined || queue === undefined) {
      throw new Error("Expected canonical and task queue sheets");
    }

    canonical.values[0] = ["id", "name", "_version", "legacy_note"];
    canonical.values.push(["u1", "old", 1, "keep-me"]);

    gateway.enqueueTasks_(spreadsheet, {
      tasks: [
        {
          taskId: "task-delete-extra-column",
          transactionId: "tx-delete-extra-column",
          transactionIndex: 0,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: 1,
          payloadJson: JSON.stringify({
            rowToDelete: { id: "u1", name: "old", _version: 1 },
          }),
        },
      ],
    });

    queue.values[1]![4] = "processing";
    queue.values[1]![15] = "2020-01-01T00:00:00.000Z";

    expect(gateway.processTaskQueue_(spreadsheet, {})).toMatchObject({
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 1,
      failedTasks: 0,
      remainingPendingTasks: 0,
    });
    expect(queue.values[1]![4]).toBe("done");
    expect(canonical.values).toEqual([
      ["id", "name", "_version", "legacy_note"],
      ["", "", "", ""],
    ]);
  });

  it("does not adopt a colliding internal sheet without a stored mapping", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();
    const collidingName = gateway.createCanonicalSheetName_(
      "Users",
      gateway.createShortHash_("Users"),
      0,
    );

    spreadsheet.insertSheet(collidingName);

    const result = gateway.initializeSystemSheets_(spreadsheet, {
      sheetName: "Users",
      headers: ["id", "_version"],
    });

    expect(result.canonicalSheetName).not.toBe(collidingName);
    expect(result.canonicalSheetName).toBe(
      gateway.createCanonicalSheetName_(
        "Users",
        gateway.createShortHash_("Users"),
        1,
      ),
    );
  });

  it("continues when best-effort sheet protection fails", async () => {
    const logs: string[] = [];
    const gateway = await loadGatewayTemplate(logs);
    const spreadsheet = new FakeSpreadsheet({ protectThrows: true });

    expect(() =>
      gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "Users",
        headers: ["id", "_version"],
      }),
    ).not.toThrow();

    expect(logs).toEqual([
      "typed-sheets could not protect internal sheet "
        + gateway.createCanonicalSheetName_(
          "Users",
          gateway.createShortHash_("Users"),
          0,
        )
        + ": protection denied",
      "typed-sheets could not protect internal sheet _typed_sheets_task_queue: protection denied",
    ]);
  });

  it("rejects projection names reserved for typed-sheets internals", async () => {
    const gateway = await loadGatewayTemplate();
    const spreadsheet = new FakeSpreadsheet();

    expect(() =>
      gateway.initializeSystemSheets_(spreadsheet, {
        sheetName: "_typed_sheets_data_Users",
        headers: ["id", "_version"],
      }),
    ).toThrow(/sheetName must not start with _typed_sheets_/);
  });
});
