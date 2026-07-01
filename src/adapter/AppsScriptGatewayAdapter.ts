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
    const response = await this.request<{
      headers: string[];
      rows: SheetSnapshot["rows"];
    }>({
      operation: "readSheet",
      sheetName,
    });

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

  private async request<T>(payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetch(this.options.gatewayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        secret: this.options.gatewaySecret,
      }),
    });

    const body = await response.json();

    if (!isGatewayResponse(body)) {
      throw new Error("Apps Script gateway returned an invalid response");
    }

    if (!body.ok) {
      const code = typeof body.code === "string" ? body.code : body.error;
      const message = typeof body.message === "string" ? body.message : code;

      throw new Error(
        `Apps Script gateway failed: ${message ?? "unknown_error"}`,
      );
    }

    return body as T;
  }
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
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}
