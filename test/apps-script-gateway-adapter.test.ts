import { describe, expect, it, vi } from "vitest";

import { ConflictError, SchemaDriftError } from "../src/core/Errors.js";
import {
  AppsScriptGatewayAdapter,
  type AppsScriptQueueAdapter,
} from "../src/index.js";

function createJsonResponse(value: unknown): Response {
  return {
    json: vi.fn().mockResolvedValue(value),
  } as unknown as Response;
}

describe("AppsScriptGatewayAdapter", () => {
  it("reads a sheet through the Apps Script gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        headers: ["id", "email", "_version"],
        rows: [
          { rowNumber: 2, cells: ["u1", "a@test.com", 1] },
          { rowNumber: 3, cells: ["u2", "b@test.com", 2] },
        ],
      }),
    );

    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(adapter.readSheet("Users")).resolves.toEqual({
      headers: ["id", "email", "_version"],
      rows: [
        { rowNumber: 2, cells: ["u1", "a@test.com", 1] },
        { rowNumber: 3, cells: ["u2", "b@test.com", 2] },
      ],
    });
    expectGatewayRequest(fetch, {
      operation: "readSheet",
      secret: "gateway-secret",
      sheetName: "Users",
    });
  });

  it("appends a row through the Apps Script gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.appendRow("Users", ["u1", "a@test.com", true, 1]);

    expectGatewayRequest(fetch, {
      operation: "appendRow",
      secret: "gateway-secret",
      sheetName: "Users",
      row: ["u1", "a@test.com", true, 1],
    });
  });

  it("appends multiple rows through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.appendRows("Users", {
      rows: [
        ["u1", "a@test.com", true, 1],
        ["u2", "b@test.com", false, 1],
      ],
    });

    expectGatewayRequest(fetch, {
      operation: "appendRows",
      secret: "gateway-secret",
      sheetName: "Users",
      rows: [
        ["u1", "a@test.com", true, 1],
        ["u2", "b@test.com", false, 1],
      ],
    });
  });

  it("updates a row through the Apps Script gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.updateRow("Users", 3, ["u2", "b@test.com", false, 2]);

    expectGatewayRequest(fetch, {
      operation: "updateRow",
      secret: "gateway-secret",
      sheetName: "Users",
      rowNumber: 3,
      row: ["u2", "b@test.com", false, 2],
    });
  });

  it("updates rows by key through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        updatedRows: [{ id: "u1", cells: ["u1", "a@test.com", 21, true, 2] }],
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.updateRowsByKey("Users", {
        expectedHeaders: ["id", "email", "age", "active", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        updates: [
          {
            id: "u1",
            expectedVersion: 1,
            row: ["u1", "a@test.com", 21, true, 2],
          },
        ],
      }),
    ).resolves.toEqual({
      updatedRows: [{ id: "u1", cells: ["u1", "a@test.com", 21, true, 2] }],
    });
    expectGatewayRequest(fetch, {
      operation: "updateRowsByKey",
      secret: "gateway-secret",
      sheetName: "Users",
      expectedHeaders: ["id", "email", "age", "active", "_version"],
      keyHeader: "id",
      versionHeader: "_version",
      updates: [
        {
          id: "u1",
          expectedVersion: 1,
          row: ["u1", "a@test.com", 21, true, 2],
        },
      ],
    });
  });

  it("rejects invalid updateRowsByKey response payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        updatedRows: [{ id: "u1", cells: ["u1", undefined, 2] }],
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.updateRowsByKey("Users", {
        expectedHeaders: ["id", "email", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        updates: [
          {
            id: "u1",
            expectedVersion: 1,
            row: ["u1", "a@test.com", 2],
          },
        ],
      }),
    ).rejects.toThrow(
      /Apps Script gateway returned an invalid updateRowsByKey response/,
    );
  });

  it("deletes a row through the Apps Script gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.deleteRow("Users", 3);

    expectGatewayRequest(fetch, {
      operation: "deleteRow",
      secret: "gateway-secret",
      sheetName: "Users",
      rowNumber: 3,
    });
  });

  it("deletes multiple rows through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.deleteRows("Users", [5, 3]);

    expectGatewayRequest(fetch, {
      operation: "deleteRows",
      secret: "gateway-secret",
      sheetName: "Users",
      rowNumbers: [5, 3],
    });
  });

  it("deletes multiple rows by key through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        deletedRows: [
          { id: "u1", cells: ["u1", "a@test.com", 1] },
          { id: "u3", cells: ["u3", "c@test.com", 1] },
        ],
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.deleteRowsByKey("Users", {
        expectedHeaders: ["id", "email", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        ids: ["u1", "u3"],
        versionsById: {
          u1: 1,
          u3: 1,
        },
      }),
    ).resolves.toEqual({
      deletedRows: [
        { id: "u1", cells: ["u1", "a@test.com", 1] },
        { id: "u3", cells: ["u3", "c@test.com", 1] },
      ],
    });
    expectGatewayRequest(fetch, {
      operation: "deleteRowsByKey",
      secret: "gateway-secret",
      sheetName: "Users",
      expectedHeaders: ["id", "email", "_version"],
      keyHeader: "id",
      versionHeader: "_version",
      ids: ["u1", "u3"],
      versionsById: {
        u1: 1,
        u3: 1,
      },
    });
  });

  it("ensures a sheet through the Apps Script gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.ensureSheet("Users");

    expectGatewayRequest(fetch, {
      operation: "ensureSheet",
      secret: "gateway-secret",
      sheetName: "Users",
    });
  });

  it("writes headers through the Apps Script gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.writeHeader("Users", ["id", "email", "_version"]);

    expectGatewayRequest(fetch, {
      operation: "writeHeader",
      secret: "gateway-secret",
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
  });

  it("initializes a sheet with headers through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await adapter.initializeSheet("Users", ["id", "email", "_version"]);

    expectGatewayRequest(fetch, {
      operation: "initializeSheet",
      secret: "gateway-secret",
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
  });

  it("initializes system sheets through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        systemSheets: {
          logicalSheetName: "Users",
          canonicalSheetName: "_typed_sheets_data_Users_a1b2c3d4e5f6",
          projectionSheetName: "Users",
          taskQueueSheetName: "_typed_sheets_task_queue",
        },
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.initializeSystemSheets("Users", ["id", "email", "_version"]),
    ).resolves.toEqual({
      logicalSheetName: "Users",
      canonicalSheetName: "_typed_sheets_data_Users_a1b2c3d4e5f6",
      projectionSheetName: "Users",
      taskQueueSheetName: "_typed_sheets_task_queue",
    });
    expectGatewayRequest(fetch, {
      operation: "initializeSystemSheets",
      secret: "gateway-secret",
      sheetName: "Users",
      headers: ["id", "email", "_version"],
    });
  });

  it("exposes system sheet initialization through the AppsScriptQueueAdapter boundary", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        systemSheets: {
          logicalSheetName: "Users",
          canonicalSheetName: "_typed_sheets_data_Users_a1b2c3d4e5f6",
          projectionSheetName: "Users",
          taskQueueSheetName: "_typed_sheets_task_queue",
        },
      }),
    );
    const adapter: AppsScriptQueueAdapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.initializeSystemSheets("Users", ["id", "_version"]),
    ).resolves.toEqual({
      logicalSheetName: "Users",
      canonicalSheetName: "_typed_sheets_data_Users_a1b2c3d4e5f6",
      projectionSheetName: "Users",
      taskQueueSheetName: "_typed_sheets_task_queue",
    });
  });

  it("rejects invalid initializeSystemSheets response payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        systemSheets: {
          logicalSheetName: "Users",
          canonicalSheetName: "_typed_sheets_data_Users_a1b2c3d4e5f6",
          projectionSheetName: "Users",
        },
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.initializeSystemSheets("Users", ["id", "email", "_version"]),
    ).rejects.toThrow(
      /Apps Script gateway returned an invalid initializeSystemSheets response/,
    );
  });

  it("enqueues write tasks through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        tasks: [
          { taskId: "task-1", sequence: 41 },
          { taskId: "task-2", sequence: 42 },
        ],
      }),
    );
    const adapter: AppsScriptQueueAdapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.enqueueTasks({
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
      }),
    ).resolves.toEqual({
      tasks: [
        { taskId: "task-1", sequence: 41 },
        { taskId: "task-2", sequence: 42 },
      ],
    });

    expectGatewayRequest(fetch, {
      operation: "enqueueTasks",
      secret: "gateway-secret",
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
  });

  it("rejects invalid enqueueTasks response payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        tasks: [{ taskId: "task-1", sequence: "1" }],
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.enqueueTasks({
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
        ],
      }),
    ).rejects.toThrow(
      /Apps Script gateway returned an invalid enqueueTasks response/,
    );
  });

  it("processes queued tasks through one Apps Script gateway request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        processedTransactions: 2,
        failedTransactions: 1,
        processedTasks: 4,
        failedTasks: 2,
        remainingPendingTasks: 3,
      }),
    );
    const adapter: AppsScriptQueueAdapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.processTaskQueue({ maxTransactions: 3 }),
    ).resolves.toEqual({
      processedTransactions: 2,
      failedTransactions: 1,
      processedTasks: 4,
      failedTasks: 2,
      remainingPendingTasks: 3,
    });
    expectGatewayRequest(fetch, {
      operation: "processTaskQueue",
      secret: "gateway-secret",
      maxTransactions: 3,
    });
  });

  it("rejects invalid processTaskQueue response payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        processedTransactions: 1,
        failedTransactions: 0,
        processedTasks: 1,
        failedTasks: 0,
        remainingPendingTasks: "0",
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(adapter.processTaskQueue()).rejects.toThrow(
      /Apps Script gateway returned an invalid processTaskQueue response/,
    );
  });

  it("throws the gateway error when the gateway returns ok false", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: false,
        error: "unauthorized",
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "wrong-secret",
      fetch,
    });

    await expect(adapter.readSheet("Users")).rejects.toThrow(
      /Apps Script gateway failed: unauthorized/,
    );
  });

  it("preserves fetch failures as the error cause", async () => {
    const cause = new Error("network unavailable");
    const fetch = vi.fn().mockRejectedValue(cause);
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    try {
      await adapter.readSheet("Users");
      throw new Error("Expected readSheet to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Failed to fetch Apps Script gateway",
      );
      expect((error as Error).cause).toBe(cause);
    }
  });

  it("prefers the gateway error message when present", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: false,
        code: "invalid_request",
        error: "invalid_request",
        message: "sheetName must be a non-empty string",
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(adapter.readSheet("")).rejects.toThrow(
      /Apps Script gateway failed: sheetName must be a non-empty string/,
    );
  });

  it("maps gateway conflict errors to ConflictError", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: false,
        code: "conflict",
        error: "conflict",
        message: 'Stale delete for key "u1"',
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.deleteRowsByKey("Users", {
        expectedHeaders: ["id", "email", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        ids: ["u1"],
        versionsById: {
          u1: 1,
        },
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("maps gateway schema drift errors to SchemaDriftError", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: false,
        code: "schema_drift",
        error: "schema_drift",
        message: 'Duplicate key "u1"',
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(
      adapter.deleteRowsByKey("Users", {
        expectedHeaders: ["id", "email", "_version"],
        keyHeader: "id",
        versionHeader: "_version",
        ids: ["u1"],
        versionsById: {
          u1: 1,
        },
      }),
    ).rejects.toThrow(SchemaDriftError);
  });

  it("rejects invalid readSheet response payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(
      createJsonResponse({
        ok: true,
        headers: ["id", "email", "_version"],
        rows: [{ rowNumber: 2, cells: ["u1", undefined, 1] }],
      }),
    );
    const adapter = new AppsScriptGatewayAdapter({
      gatewayUrl: "https://script.google.com/macros/s/deployment-id/exec",
      gatewaySecret: "gateway-secret",
      fetch,
    });

    await expect(adapter.readSheet("Users")).rejects.toThrow(
      /Apps Script gateway returned an invalid readSheet response/,
    );
  });
});

function expectGatewayRequest(
  fetch: ReturnType<typeof vi.fn>,
  body: Record<string, unknown>,
): void {
  expect(fetch).toHaveBeenCalledTimes(1);

  const [url, request] = fetch.mock.calls[0] as [
    string,
    RequestInit & { body: string },
  ];

  expect(url).toBe("https://script.google.com/macros/s/deployment-id/exec");
  expect(request.method).toBe("POST");
  expect(request.headers).toEqual({
    "content-type": "application/json",
  });
  expect(JSON.parse(request.body)).toEqual(body);
}
