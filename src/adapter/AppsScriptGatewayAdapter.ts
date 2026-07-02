import type { SheetAdapter, SheetCell, SheetSnapshot } from "./Adapter.js";

type GatewayFetch = typeof fetch;

export interface AppsScriptGatewayAdapterOptions {
  gatewayUrl: string;
  gatewaySecret: string;
  fetch?: GatewayFetch;
}

export class AppsScriptGatewayAdapter implements SheetAdapter {
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

  async appendRow(sheetName: string, row: SheetCell[]): Promise<void> {
    await this.request({
      operation: "appendRow",
      sheetName,
      row,
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

  // Sends row deletion through the gateway so service-account-free setups expose
  // the same repository contract as the direct Google Sheets adapter.
  async deleteRow(sheetName: string, rowNumber: number): Promise<void> {
    await this.request({
      operation: "deleteRow",
      sheetName,
      rowNumber,
    });
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

  private async request(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;

    try {
      response = await this.fetch(this.options.gatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          secret: this.options.gatewaySecret,
        }),
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

      throw new Error(
        `Apps Script gateway failed: ${message ?? "unknown_error"}`,
      );
    }

    return gatewayResponse;
  }
}

function requireReadSheetResponse(value: Record<string, unknown>): SheetSnapshot {
  if (
    !Array.isArray(value.headers) ||
    !value.headers.every((header) => typeof header === "string") ||
    !Array.isArray(value.rows) ||
    !value.rows.every(isSheetRowSnapshot)
  ) {
    throw new Error("Apps Script gateway returned an invalid readSheet response");
  }

  return {
    headers: value.headers,
    rows: value.rows,
  };
}

function requireGatewayResponse(
  value: unknown,
): {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
} & Record<string, unknown> {
  if (!isGatewayResponse(value)) {
    throw new Error("Apps Script gateway returned an invalid response");
  }

  return value;
}

function isGatewayResponse(
  value: unknown,
): value is {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
} & Record<string, unknown> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
