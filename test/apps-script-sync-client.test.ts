import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../src/core/state/constants.js";
import {
  AppsScriptSyncGatewayClient,
} from "../src/adapter/apps-script-gateway/syncClient.js";
import {
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
} from "../src/adapter/apps-script-gateway/errors.js";
import type {
  ApplySyncEffectsRequest,
  SyncGatewayEffect,
} from "../src/runtime/gateway/syncGateway.js";

const clientOptions = {
  url: "https://example.test/apps-script-gateway",
  secret: "secret",
  sheetId: "sheet-1",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Apps Script sync gateway client contracts", () => {
  it("converts nullable snapshot wire fields into Presence values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gatewayResponse({
      protocolVersion: "v1",
      sheetName: "User_Input",
      registeredRange: "A:Z",
      projection: "user_input",
      schemaVersion: 1,
      headers: ["name"],
      rows: [{
        rowNumber: 2,
        physicalAnchor: "anchor-1",
        visibleRevision: null,
        visibleHash: null,
        cells: {
          name: {
            cellKind: "literal",
            normalizedCell: { kind: "string", value: "Ada" },
            formulaHash: null,
            mergeRange: null,
            errorCode: null,
            stableHash: null,
          },
        },
      }],
      snapshotHash: "snapshot-1",
      unanchoredRows: [],
      duplicateAnchors: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await new AppsScriptSyncGatewayClient(clientOptions).readSnapshot({
      physicalSheetId: "physical-1",
      sheetName: "User_Input",
      registeredRange: "A:Z",
      projection: "user_input",
      schemaVersion: 1,
    });

    expect(snapshot.rows[0]?.physicalAnchor).toEqual({
      kind: PRESENCE_KINDS.PRESENT,
      value: "anchor-1",
    });
    expect(snapshot.rows[0]?.visibleRevision).toEqual({ kind: PRESENCE_KINDS.ABSENT });
    expect(snapshot.rows[0]?.visibleHash).toEqual({ kind: PRESENCE_KINDS.ABSENT });
  });

  it("serializes internal Presence and Applicability absence only at the wire boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gatewayResponse({
      results: [],
      snapshotHash: null,
      hasMore: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const effect: SyncGatewayEffect = {
      effectId: "effect-1",
      payloadHash: "payload-hash",
      effectKind: "system_projection",
      physicalSheetId: "physical-1",
      projection: "system_state",
      targetKind: "projection_row",
      targetId: "target-1",
      rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
      conflictId: { kind: PRESENCE_KINDS.ABSENT },
      expectedVisibleRevision: 1,
      expectedVisibleHash: "expected-hash",
      repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
      payload: {
        sheetName: "System_State",
        registeredRange: "A:Z",
        schemaVersion: 1,
        targetAnchor: "anchor-1",
        fields: { name: { kind: "string", value: "Ada" } },
        targetVisibleHash: "target-hash",
        createIfMissing: true,
        expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
      },
    };
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: "physical-1",
      sheetName: "System_State",
      registeredRange: "A:Z",
      projection: "system_state",
      schemaVersion: 1,
      effects: [effect],
    };

    const result = await new AppsScriptSyncGatewayClient(clientOptions).applyEffects(request);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(body.payload.effects[0].rowBindingId).toBeNull();
    expect(body.payload.effects[0].payload.expectedCandidateHash).toBeNull();
    expect(result.snapshotHash).toEqual({ kind: PRESENCE_KINDS.ABSENT });
  });

  it("keeps transport status and remote error code typed when the gateway rejects a request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gatewayResponse(
      { ok: false, error: { code: "invalid_signature", message: "signature rejected" } },
      401,
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppsScriptSyncGatewayClient(clientOptions).readSnapshot({
      physicalSheetId: "physical-1",
      sheetName: "User_Input",
      registeredRange: "A:Z",
      projection: "user_input",
      schemaVersion: 1,
    })).rejects.toMatchObject({
      name: "AppsScriptSyncGatewayError",
      code: SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
      status: { kind: PRESENCE_KINDS.PRESENT, value: 401 },
      remoteCode: { kind: PRESENCE_KINDS.PRESENT, value: "invalid_signature" },
    });
    await expect(new AppsScriptSyncGatewayClient(clientOptions).readSnapshot({
      physicalSheetId: "physical-1",
      sheetName: "User_Input",
      registeredRange: "A:Z",
      projection: "user_input",
      schemaVersion: 1,
    })).rejects.toBeInstanceOf(AppsScriptSyncGatewayError);
  });
});

function gatewayResponse(result: unknown, status = 200): {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(
      result && typeof result === "object" && "ok" in result
        ? result
        : { ok: true, result },
    ),
  };
}
