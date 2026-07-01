import { describe, expect, it, vi } from "vitest";

import { AppsScriptGatewayAdapter } from "../src/index.js";

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
