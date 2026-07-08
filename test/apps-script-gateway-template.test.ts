import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface GatewayTemplate {
  TYPED_SHEETS_TASK_QUEUE_HEADERS: string[];
  TYPED_SHEETS_TASK_QUEUE_SHEET_NAME: string;
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
}

class FakeSpreadsheet {
  readonly insertedSheetNames: string[] = [];
  readonly sheets = new Map<string, FakeSheet>();

  constructor(private readonly options: { protectThrows?: boolean } = {}) {}

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
  clearContentRanges: Array<{
    row: number;
    column: number;
    rowCount: number;
    columnCount: number;
  }> = [];
  values: unknown[][] = [];

  constructor(
    name: string,
    private readonly options: { protectThrows?: boolean } = {},
  ) {
    this.name = name;
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
        "  createCanonicalSheetName_,",
        "  createShortHash_,",
        "  getGatewayUrl_,",
        "  enqueueTasks_,",
        "  processTaskQueue_,",
        "  initializeSystemSheets_,",
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
        return Array.from({ length: 32 }, (_, index) => {
          const code = value.charCodeAt(index % value.length) || 0;
          return ((code + index * 17) % 256) - 128;
        });
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
            nextRow: {
              id: "o1",
              total: 20,
              _version: 2,
            },
          }),
        },
      ],
    });
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
            previousRow: {
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

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values[0]).toEqual(gateway.TYPED_SHEETS_TASK_QUEUE_HEADERS);
    expect(queue?.hideCalls).toBe(2);
    expect(queue?.protectCalls).toBe(2);
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
          nextRow: {
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
          previousRow: {
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

    expect(
      gateway.enqueueTasks_(spreadsheet, {
        tasks: [task],
      }),
    ).toEqual({
      ok: true,
      tasks: [{ taskId: "task-1", sequence: 1 }],
    });

    const queue = spreadsheet.sheets.get("_typed_sheets_task_queue");

    expect(queue?.values).toHaveLength(2);
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
        nextRow: { id: "u1", _version: 2 },
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
        previousRow: { id: "u2", _version: 1 },
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
            nextRow: {
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
            previousRow: {
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
            nextRow: {
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
            nextRow: {
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

  it("fails update tasks with a missing next row version", async () => {
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
            nextRow: {
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
    expect(queue?.values[1]?.[13]).toMatch(/payload.nextRow._version/);
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
            previousRow: { id: "u2", _version: 1 },
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
      queue.values[1][4] = "done";
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
