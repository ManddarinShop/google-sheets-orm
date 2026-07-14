import type {
  AppendRowsInput,
  DeleteRowsByKeyInput,
  DeleteRowsByKeyResult,
  DirectSheetAdapter,
  UpdateRowsByKeyInput,
  UpdateRowsByKeyResult,
} from "./direct/DirectSheetAdapter.js";
import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
  EnqueueTasksResult,
  InitializeSystemSheetsResult,
  ProcessTaskQueueInput,
  ProcessTaskQueueResult,
} from "./queued/QueuedSheetAdapter.js";
import type {
  SheetCell,
  SheetSnapshot,
} from "./shared/SheetAdapter.js";
import { ConflictError, SchemaDriftError } from "../core/errors/index.js";
import type {
  AppsScriptGatewayAuthenticatedRequest,
  AppsScriptGatewayDeleteRowsByKeyResponse,
  AppsScriptGatewayEnqueueTasksResponse,
  AppsScriptGatewayInitializeSystemSheetsResponse,
  AppsScriptGatewayProcessTaskQueueResponse,
  AppsScriptGatewayReadSheetResponse,
  AppsScriptGatewayRequest,
  AppsScriptGatewayResponse,
  AppsScriptGatewayUpdateRowsByKeyResponse,
} from "./AppsScriptGatewayProtocol.js";

type GatewayFetch = typeof fetch;

export interface AppsScriptGatewayAdapterOptions {
  gatewayUrl: string;
  gatewaySecret: string;
  fetch?: GatewayFetch;
}

export class AppsScriptGatewayAdapter
  implements DirectSheetAdapter, AppsScriptQueueAdapter {
  private readonly fetch: GatewayFetch;

  constructor(private readonly options: AppsScriptGatewayAdapterOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    const response = requireReadSheetResponse(
      await this.request({
        operation: "readSheet",
        sheetName,
      }),
    );

    return {
      headers: response.headers,
      rows: response.rows,
    };
  }

  /** Reads canonical repository state so queued writes are visible after processing. */
  async readCanonicalSheet(sheetName: string): Promise<SheetSnapshot> {
    const response = requireReadSheetResponse(
      await this.request({
        operation: "readCanonicalSheet",
        sheetName,
      }),
    );

    return {
      headers: response.headers,
      rows: response.rows,
    };
  }

  async appendRow(sheetName: string, row: SheetCell[]): Promise<void> {
    await this.request({
      operation: "appendRow",
      sheetName,
      row,
    });
  }

  /**
   * Sends multiple appended rows through one gateway request to avoid per-row
   * Apps Script startup and network overhead for bursty repository inserts.
   */
  async appendRows(sheetName: string, input: AppendRowsInput): Promise<void> {
    await this.request({
      operation: "appendRows",
      sheetName,
      rows: input.rows,
    });
  }

  async updateRow(
    sheetName: string,
    rowNumber: number,
    row: SheetCell[],
  ): Promise<void> {
    await this.request({
      operation: "updateRow",
      sheetName,
      rowNumber,
      row,
    });
  }

  /**
   * Lets the gateway update by key under the Apps Script document lock. This
   * preserves optimistic locking while avoiding a second repository-side read.
   */
  async updateRowsByKey(
    sheetName: string,
    input: UpdateRowsByKeyInput,
  ): Promise<UpdateRowsByKeyResult> {
    const response = requireUpdateRowsByKeyResponse(
      await this.request({
        operation: "updateRowsByKey",
        sheetName,
        expectedHeaders: input.expectedHeaders,
        keyHeader: input.keyHeader,
        versionHeader: input.versionHeader,
        updates: input.updates,
      }),
    );

    return {
      updatedRows: response.updatedRows,
    };
  }

  // Sends row deletion through the gateway so service-account-free setups expose
  // the same repository contract as the direct Google Sheets adapter.
  async deleteRow(sheetName: string, rowNumber: number): Promise<void> {
    await this.request({
      operation: "deleteRow",
      sheetName,
      rowNumber,
    });
  }

  /**
   * Deletes multiple rows through one gateway request. The Apps Script handler
   * owns bottom-up ordering so repository batching does not corrupt row numbers.
   */
  async deleteRows(sheetName: string, rowNumbers: number[]): Promise<void> {
    await this.request({
      operation: "deleteRows",
      sheetName,
      rowNumbers,
    });
  }

  /**
   * Lets the gateway delete by key under the Apps Script document lock. This
   * keeps stale-delete validation close to the sheet and avoids a second
   * repository-side readSheet call for gateway-backed repositories.
   */
  async deleteRowsByKey(
    sheetName: string,
    input: DeleteRowsByKeyInput,
  ): Promise<DeleteRowsByKeyResult> {
    const response = requireDeleteRowsByKeyResponse(
      await this.request({
        operation: "deleteRowsByKey",
        sheetName,
        expectedHeaders: input.expectedHeaders,
        keyHeader: input.keyHeader,
        versionHeader: input.versionHeader,
        ids: input.ids,
        versionsById: input.versionsById,
      }),
    );

    return {
      deletedRows: response.deletedRows,
    };
  }

  async ensureSheet(sheetName: string): Promise<void> {
    await this.request({
      operation: "ensureSheet",
      sheetName,
    });
  }

  async writeHeader(sheetName: string, headers: string[]): Promise<void> {
    await this.request({
      operation: "writeHeader",
      sheetName,
      headers,
    });
  }

  async initializeSheet(sheetName: string, headers: string[]): Promise<void> {
    await this.request({
      operation: "initializeSheet",
      sheetName,
      headers,
    });
  }

  /**
   * Initializes the gateway-owned sheet set for queued writes. The Apps Script
   * gateway creates the visible projection sheet, hidden canonical data sheet,
   * and hidden task queue sheet while persisting the canonical mapping in meta.
   */
  async initializeSystemSheets(
    sheetName: string,
    headers: string[],
  ): Promise<InitializeSystemSheetsResult> {
    const response = requireInitializeSystemSheetsResponse(
      await this.request({
        operation: "initializeSystemSheets",
        sheetName,
        headers,
      }),
    );

    return response.systemSheets;
  }

  /**
   * Appends prepared repository write tasks to the gateway queue. The gateway
   * owns sequence assignment under the Apps Script document lock.
   */
  async enqueueTasks(input: EnqueueTasksInput): Promise<EnqueueTasksResult> {
    const response = requireEnqueueTasksResponse(
      await this.request({
        operation: "enqueueTasks",
        tasks: input.tasks,
      }),
      input.tasks,
    );

    return {
      tasks: response.tasks,
    };
  }

  /**
   * Runs the Apps Script queue processor for a bounded number of transaction
   * groups. The processor applies pending tasks to canonical sheets.
   */
  async processTaskQueue(
    input: ProcessTaskQueueInput = {},
  ): Promise<ProcessTaskQueueResult> {
    const request: AppsScriptGatewayRequest = {
      operation: "processTaskQueue",
    };

    if (input.maxTransactions !== undefined) {
      request.maxTransactions = input.maxTransactions;
    }

    const response = requireProcessTaskQueueResponse(
      await this.request(request),
    );

    const result: ProcessTaskQueueResult = {
      processedTransactions: response.processedTransactions,
      failedTransactions: response.failedTransactions,
      processedTasks: response.processedTasks,
      failedTasks: response.failedTasks,
      remainingPendingTasks: response.remainingPendingTasks,
    };

    if (response.recoveryPendingTasks !== undefined) {
      result.recoveryPendingTasks = response.recoveryPendingTasks;
    }

    return result;
  }

  private async request(
    payload: AppsScriptGatewayRequest,
  ): Promise<AppsScriptGatewayResponse> {
    let response: Response;
    const bodyPayload: AppsScriptGatewayAuthenticatedRequest = {
      ...payload,
      secret: this.options.gatewaySecret,
    };

    try {
      response = await this.fetch(this.options.gatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });
    } catch (error) {
      throw new Error("Failed to fetch Apps Script gateway", {
        cause: error,
      });
    }

    const body: unknown = await response.json();
    const gatewayResponse = requireGatewayResponse(body);

    if (gatewayResponse.ok === false) {
      const code = gatewayResponse.code ?? gatewayResponse.error;
      const message = gatewayResponse.message ?? code;

      throw createGatewayError(code, message);
    }

    return gatewayResponse;
  }
}

function createGatewayError(
  code: string | undefined,
  message: string | undefined,
): Error {
  const safeMessage = message ?? code ?? "unknown_error";

  if (code === "conflict") {
    return new ConflictError(safeMessage);
  }

  if (code === "schema_drift") {
    return new SchemaDriftError(safeMessage);
  }

  return new Error(`Apps Script gateway failed: ${safeMessage}`);
}

function requireReadSheetResponse(
  value: AppsScriptGatewayResponse,
): AppsScriptGatewayReadSheetResponse {
  if (
    !Array.isArray(value.headers) ||
    !value.headers.every((header) => typeof header === "string") ||
    !Array.isArray(value.rows) ||
    !value.rows.every(isSheetRowSnapshot)
  ) {
    throw new Error("Apps Script gateway returned an invalid readSheet response");
  }

  return {
    ...value,
    headers: value.headers,
    rows: value.rows,
  };
}

function requireInitializeSystemSheetsResponse(
  value: AppsScriptGatewayResponse,
): AppsScriptGatewayInitializeSystemSheetsResponse {
  if (!isSystemSheetsResult(value.systemSheets)) {
    throw new Error(
      "Apps Script gateway returned an invalid initializeSystemSheets response",
    );
  }

  return {
    ...value,
    systemSheets: value.systemSheets,
  };
}

function requireEnqueueTasksResponse(
  value: AppsScriptGatewayResponse,
  expectedTasks: EnqueueTasksInput["tasks"],
): AppsScriptGatewayEnqueueTasksResponse {
  const actualTaskIds = Array.isArray(value.tasks)
    ? value.tasks
      .filter(isEnqueuedTaskResult)
      .map((task) => task.taskId)
      .sort()
    : [];
  const expectedTaskIds = expectedTasks.map((task) => task.taskId).sort();

  if (
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isEnqueuedTaskResult) ||
    actualTaskIds.length !== expectedTaskIds.length ||
    actualTaskIds.some((taskId, index) => taskId !== expectedTaskIds[index])
  ) {
    throw new Error(
      "Apps Script gateway returned an invalid enqueueTasks response",
    );
  }

  return {
    ...value,
    tasks: value.tasks,
  };
}

function requireProcessTaskQueueResponse(
  value: AppsScriptGatewayResponse,
): AppsScriptGatewayProcessTaskQueueResponse {
  if (
    !isNonNegativeInteger(value.processedTransactions) ||
    !isNonNegativeInteger(value.failedTransactions) ||
    !isNonNegativeInteger(value.processedTasks) ||
    !isNonNegativeInteger(value.failedTasks) ||
    !isNonNegativeInteger(value.remainingPendingTasks)
    || (
      value.recoveryPendingTasks !== undefined
      && !isNonNegativeInteger(value.recoveryPendingTasks)
    )
  ) {
    throw new Error(
      "Apps Script gateway returned an invalid processTaskQueue response",
    );
  }

  return {
    ...value,
    processedTransactions: value.processedTransactions,
    failedTransactions: value.failedTransactions,
    processedTasks: value.processedTasks,
    failedTasks: value.failedTasks,
    remainingPendingTasks: value.remainingPendingTasks,
    ...(value.recoveryPendingTasks === undefined
      ? {}
      : { recoveryPendingTasks: value.recoveryPendingTasks }),
  };
}

function requireDeleteRowsByKeyResponse(
  value: AppsScriptGatewayResponse,
): AppsScriptGatewayDeleteRowsByKeyResponse {
  if (
    !Array.isArray(value.deletedRows) ||
    !value.deletedRows.every(isDeletedRowByKeyResult)
  ) {
    throw new Error(
      "Apps Script gateway returned an invalid deleteRowsByKey response",
    );
  }

  return {
    ...value,
    deletedRows: value.deletedRows,
  };
}

function requireUpdateRowsByKeyResponse(
  value: AppsScriptGatewayResponse,
): AppsScriptGatewayUpdateRowsByKeyResponse {
  if (
    !Array.isArray(value.updatedRows) ||
    !value.updatedRows.every(isUpdatedRowByKeyResult)
  ) {
    throw new Error(
      "Apps Script gateway returned an invalid updateRowsByKey response",
    );
  }

  return {
    ...value,
    updatedRows: value.updatedRows,
  };
}

function requireGatewayResponse(value: unknown): AppsScriptGatewayResponse {
  if (!isGatewayResponse(value)) {
    throw new Error("Apps Script gateway returned an invalid response");
  }

  return value;
}

function isGatewayResponse(
  value: unknown,
): value is AppsScriptGatewayResponse {
  return (
    isRecord(value) &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    isOptionalString(value.code) &&
    isOptionalString(value.error) &&
    isOptionalString(value.message)
  );
}

function isSheetRowSnapshot(
  value: unknown,
): value is SheetSnapshot["rows"][number] {
  if (!isRecord(value)) {
    return false;
  }

  const rowNumber = value.rowNumber;

  return (
    typeof rowNumber === "number" &&
    Number.isInteger(rowNumber) &&
    rowNumber >= 2 &&
    Array.isArray(value.cells) &&
    value.cells.every(isSheetCell)
  );
}

function isSheetCell(value: unknown): value is SheetCell {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function isSystemSheetsResult(
  value: unknown,
): value is InitializeSystemSheetsResult {
  return (
    isRecord(value) &&
    typeof value.logicalSheetName === "string" &&
    typeof value.canonicalSheetName === "string" &&
    typeof value.projectionSheetName === "string" &&
    typeof value.taskQueueSheetName === "string"
  );
}

function isEnqueuedTaskResult(
  value: unknown,
): value is EnqueueTasksResult["tasks"][number] {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isDeletedRowByKeyResult(
  value: unknown,
): value is DeleteRowsByKeyResult["deletedRows"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.cells) &&
    value.cells.every(isSheetCell)
  );
}

function isUpdatedRowByKeyResult(
  value: unknown,
): value is UpdateRowsByKeyResult["updatedRows"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.cells) &&
    value.cells.every(isSheetCell)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
