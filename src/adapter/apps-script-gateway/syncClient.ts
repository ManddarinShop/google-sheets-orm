/** Client adapter for the registry-bound Apps Script sync gateway. */

import {
  computeSyncVisibleHash,
  type SyncProjection,
  type ApplySyncEffectsRequest,
  type ApplySyncEffectsResult,
  type EnsureSyncRowAnchorsRequest,
  type EnsureSyncRowAnchorsResult,
  type ReadSyncSnapshotRequest,
  type SyncEffectPostcondition,
  type SyncGatewayEffect,
  type SyncGatewaySnapshot,
  type SyncSheetGateway,
  type SyncSnapshotCell,
  type SyncSnapshotRow,
} from "../../runtime/gateway/syncGateway.js";
import type {
  SyncGatewayProvisionRoute,
  SyncGatewayProvisioner,
} from "../../runtime/gateway/SyncGatewayBootstrap.js";
import {
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
  SYNC_GATEWAY_EFFECT_KINDS,
  SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
  type SyncGatewayEffectResultStatus,
  type SyncGatewayPostconditionDisposition,
  type SyncGatewayPostconditionStatus,
} from "../../runtime/gateway/constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../../runtime/gateway/errors.js";
import {
  requireSyncGatewayNonEmptyList,
  requireSyncGatewayNonNegativeSafeInteger,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayProjection,
  requireSyncGatewayProtocolVersion,
  requireSyncGatewayText,
} from "../../runtime/gateway/validation.js";
import {
  CELL_OBSERVATION_KINDS,
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
} from "../../core/encoding/constants.js";
import { isJavaScriptType, type CellObservationKind, type NormalizedCell } from "../../core/encoding/index.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
  type Applicability,
  type Presence,
} from "../../core/state/index.js";
import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../core/constants.js";
import {
  createSyncGatewayEnvelope,
  type SyncGatewayOperation,
  type SyncGatewayEnvelope,
  type SyncJsonValue,
} from "./syncProtocol.js";
import {
  createSyncGatewayAdminEnvelope,
  type SyncGatewayAdminEnvelope,
} from "./syncAdminProtocol.js";
import {
  SYNC_GATEWAY_ADMIN_OPERATIONS,
  SYNC_GATEWAY_CLIENT_DEFAULTS,
  SYNC_GATEWAY_OPERATIONS,
} from "./constants.js";
import {
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
} from "./errors.js";

/** Settings for one authenticated Apps Script sync-gateway client. */
export interface AppsScriptSyncGatewayClientOptions {
  readonly url: string;
  readonly secret: string;
  readonly sheetId: string;
  readonly keyId?: string;
  readonly actorId?: string;
  readonly requestTimeoutMs?: number;
}

/** One SQLite-declared projection that the trusted setup flow must materialize. */
export type SyncGatewayProvisionRegistration = SyncGatewayProvisionRoute;

/** Evidence returned after the gateway creates or verifies a projection registry. */
export type SyncGatewayProvisionResult =
  Awaited<ReturnType<SyncGatewayProvisioner["provisionRegistry"]>>;

/**
 * Implements the sync runtime gateway contract over the signed Apps Script API.
 *
 * The client does not accept an arbitrary sheet name at its public boundary:
 * each call carries the physical registry record selected by the local runtime.
 */
export class AppsScriptSyncGatewayClient implements SyncSheetGateway, SyncGatewayProvisioner {
  private readonly url: string;
  private readonly secret: string;
  private readonly sheetId: string;
  private readonly keyId: string;
  private readonly actorId: string;
  private readonly requestTimeoutMs: number;

  public constructor(options: AppsScriptSyncGatewayClientOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
        "Apps Script sync gateway URL must be valid",
      );
    }
    if (url.protocol !== "https:") {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
        "Apps Script sync gateway URL must use HTTPS",
      );
    }
    const secret = requireSyncGatewayText(
      options.secret,
      "Apps Script sync gateway secret",
      SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
    );
    const sheetId = requireSyncGatewayText(
      options.sheetId,
      "Apps Script sync gateway sheet ID",
      SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
    );
    const keyId = requireSyncGatewayText(
      options.keyId ?? "typed-sheets-shared-secret-v1",
      "Apps Script sync gateway key ID",
      SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
    );
    const actorId = requireSyncGatewayText(
      options.actorId ?? "typed-sheets-sync-worker",
      "Apps Script sync gateway actor ID",
      SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
    );
    const timeout = requireRequestTimeout(
      options.requestTimeoutMs ?? SYNC_GATEWAY_CLIENT_DEFAULTS.REQUEST_TIMEOUT_MS,
    );
    this.url = url.toString();
    this.secret = secret;
    this.sheetId = sheetId;
    this.keyId = keyId;
    this.actorId = actorId;
    this.requestTimeoutMs = timeout;
  }

  public async ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    const result = await this.invoke(
      SYNC_GATEWAY_OPERATIONS.ENSURE_ROW_ANCHORS,
      request.registeredRange,
      request,
    );
    return requireAnchorResult(result);
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    const result = await this.invoke(
      SYNC_GATEWAY_OPERATIONS.READ_SNAPSHOT,
      request.registeredRange,
      request,
    );
    return requireSnapshot(result);
  }

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    const result = await this.invoke(
      SYNC_GATEWAY_OPERATIONS.APPLY_EFFECTS,
      request.registeredRange,
      request,
    );
    return requireApplyResult(result);
  }

  /**
   * Mirrors trusted SQLite projection declarations into the bound Apps Script project.
   *
   * This is an authenticated control-plane call, not a browser-facing route:
   * it creates a missing projection tab, initializes only a fully blank header
   * row, and replaces the remote allowlist with the supplied complete registry.
   */
  public async provisionRegistry(
    registrations: readonly SyncGatewayProvisionRegistration[],
  ): Promise<SyncGatewayProvisionResult> {
    const normalized = normalizeProvisionRegistrations(registrations);
    const payload: SyncJsonValue = {
      registrations: normalized.map(toWireProvisionRegistration),
    };
    const envelope = createSyncGatewayAdminEnvelope({
      operation: SYNC_GATEWAY_ADMIN_OPERATIONS.PROVISION_REGISTRY,
      payload,
      sheetId: this.sheetId,
      secret: this.secret,
      keyId: this.keyId,
      actorId: this.actorId,
    });
    const result = requireProvisionResult(await this.post(envelope));
    requireProvisionedCheckboxControls(normalized, result);
    return result;
  }

  /** Re-reads a row and classifies a lost response without replaying the effect. */
  public async readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    if (effect.effectKind === SYNC_GATEWAY_EFFECT_KINDS.RESOLUTION_DELETE) {
      try {
        const result = await this.invoke(
          SYNC_GATEWAY_OPERATIONS.READ_EFFECT_POSTCONDITION,
          effect.payload.registeredRange,
          {
          physicalSheetId: effect.physicalSheetId,
          sheetName: effect.payload.sheetName,
          registeredRange: effect.payload.registeredRange,
          projection: effect.projection,
          schemaVersion: effect.payload.schemaVersion,
          effect,
          },
        );
        return requireEffectPostcondition(result);
      } catch {
        return unavailablePostcondition();
      }
    }
    try {
      const snapshot = await this.readSnapshot({
        physicalSheetId: effect.physicalSheetId,
        sheetName: effect.payload.sheetName,
        registeredRange: effect.payload.registeredRange,
        projection: effect.projection,
        schemaVersion: effect.payload.schemaVersion,
      });
      const row = snapshot.rows.find(
        (candidate) =>
          candidate.physicalAnchor.kind === PRESENCE_KINDS.PRESENT &&
          candidate.physicalAnchor.value === effect.payload.targetAnchor,
      );
      if (row === undefined) {
        return {
          disposition: effect.payload.createIfMissing
            ? SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED
            : SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED,
          visibleRevision: absentValue(),
          visibleHash: absentValue(),
          snapshotHash: presentValue(snapshot.snapshotHash),
        };
      }
      const fields: Record<string, SyncSnapshotCell["normalizedCell"]> = {};
      for (const fieldName of Object.keys(effect.payload.fields)) {
        const cell = row.cells[fieldName];
        if (cell === undefined) {
          return {
            disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED,
            visibleRevision: row.visibleRevision,
            visibleHash: row.visibleHash,
            snapshotHash: presentValue(snapshot.snapshotHash),
          };
        }
        fields[fieldName] = cell.normalizedCell;
      }
      const actualHash = computeSyncVisibleHash(fields);
      const visibleHash = row.visibleHash.kind === PRESENCE_KINDS.PRESENT
        ? row.visibleHash
        : presentValue(actualHash);
      const common = {
        visibleRevision: row.visibleRevision,
        visibleHash,
        snapshotHash: presentValue(snapshot.snapshotHash),
      };
      if (actualHash === effect.payload.targetVisibleHash) {
        return {
          disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED,
          ...common,
        };
      }
      if (
        actualHash === effect.expectedVisibleHash ||
        (effect.repairGuardHash.kind === PRESENCE_KINDS.PRESENT &&
          actualHash === effect.repairGuardHash.value)
      ) {
        return {
          disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED,
          ...common,
        };
      }
      return {
        disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED,
        ...common,
      };
    } catch {
      return unavailablePostcondition();
    }
  }

  private async invoke(
    operation: SyncGatewayOperation,
    registeredRange: string,
    payload: SyncGatewayRequestPayload,
  ): Promise<unknown> {
    const wirePayload = toWireGatewayPayload(operation, payload);
    const envelope = createSyncGatewayEnvelope({
      operation,
      payload: wirePayload,
      sheetId: this.sheetId,
      registeredRange,
      secret: this.secret,
      keyId: this.keyId,
      actorId: this.actorId,
    });
    return this.post(envelope);
  }

  /** Sends either a data-plane or a control-plane envelope with the same transport guardrails. */
  private async post(
    envelope: SyncGatewayEnvelope | SyncGatewayAdminEnvelope,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: controller.signal,
        redirect: "follow",
      });
      const text = await response.text();
      const status = presentValue(response.status);
      const decoded = parseGatewayResponse(text, status);
      if (!response.ok) {
        if (decoded.ok) {
          throw new AppsScriptSyncGatewayError(
            SYNC_GATEWAY_CLIENT_ERROR_CODES.HTTP_ERROR,
            "Gateway returned HTTP " + response.status,
            status,
          );
        }
        throw new AppsScriptSyncGatewayError(
          SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
          decoded.error.message,
          status,
          presentValue(decoded.error.code),
        );
      }
      if (!decoded.ok) {
        throw new AppsScriptSyncGatewayError(
          SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
          decoded.error.message,
          status,
          presentValue(decoded.error.code),
        );
      }
      return decoded.result;
    } catch (error: unknown) {
      if (error instanceof AppsScriptSyncGatewayError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppsScriptSyncGatewayError(
          SYNC_GATEWAY_CLIENT_ERROR_CODES.TIMEOUT,
          "Apps Script sync gateway request timed out",
          absentValue(),
        );
      }
      throw new AppsScriptSyncGatewayError(
        SYNC_GATEWAY_CLIENT_ERROR_CODES.NETWORK_ERROR,
        "Apps Script sync gateway request failed: " + safeMessage(error),
        absentValue(),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeProvisionRegistrations(
  registrations: readonly SyncGatewayProvisionRegistration[],
): SyncGatewayProvisionRegistration[] {
  requireSyncGatewayNonEmptyList(
    registrations,
    "sync gateway provisioning registrations",
    SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );

  const seenSheets = new Set<string>();
  return registrations.map((registration) => {
    const sheetName = requireNonBlankText(
      registration.sheetName,
      "sync gateway provisioning sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (seenSheets.has(sheetName)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync gateway provisioning cannot register one tab more than once",
      );
    }
    seenSheets.add(sheetName);

    const registeredRange = normalizeWholeColumnRange(
      registration.registeredRange,
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const projection = requireSyncGatewayProjection(
      registration.projection,
      "sync gateway provisioning projection",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const schemaVersion = requireSyncGatewayPositiveSafeInteger(
      registration.schemaVersion,
      "sync gateway provisioning schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const headers = requireStringArray(
      registration.headers,
      "sync gateway provisioning headers",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    ).map((header, index) =>
      requireNonBlankText(
        header,
        `sync gateway provisioning headers[${index}]`,
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      ));
    if (headers.length !== columnCount(registeredRange)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync gateway provisioning headers must exactly match the registered range",
      );
    }
    requireUniqueStrings(
      headers,
      "sync gateway provisioning headers",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );

    const checkboxHeaders = normalizeCheckboxHeaders(
      registration.checkboxHeaders,
      projection,
      headers,
    );
    return {
      sheetName,
      registeredRange,
      projection,
      schemaVersion,
      headers,
      ...(checkboxHeaders.length === EMPTY_ARRAY_LENGTH_ZERO ? {} : { checkboxHeaders }),
    };
  });
}

function toWireProvisionRegistration(
  registration: SyncGatewayProvisionRegistration,
): SyncJsonValue {
  return {
    sheetName: registration.sheetName,
    registeredRange: registration.registeredRange,
    projection: registration.projection,
    schemaVersion: registration.schemaVersion,
    headers: [...registration.headers],
    ...(registration.checkboxHeaders === undefined
      ? {}
      : { checkboxHeaders: [...registration.checkboxHeaders] }),
  };
}

/** Validates the small UI-control surface exposed by a Sync_Conflicts projection. */
function normalizeCheckboxHeaders(
  value: readonly string[] | undefined,
  projection: SyncProjection,
  headers: readonly string[],
): string[] {
  if (value === undefined || value.length === EMPTY_ARRAY_LENGTH_ZERO) return [];
  if (projection !== SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      "sync gateway provisioning checkbox headers are only allowed on sync_conflicts",
    );
  }
  const checkboxHeaders = value.map((header, index) =>
    requireNonBlankText(
      header,
      `sync gateway provisioning checkbox headers[${index}]`,
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    ));
  requireUniqueStrings(
    checkboxHeaders,
    "sync gateway provisioning checkbox headers",
    SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );
  const knownHeaders = new Set(headers);
  for (const header of checkboxHeaders) {
    if (!knownHeaders.has(header)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync gateway provisioning checkbox headers must be declared headers",
      );
    }
  }
  return checkboxHeaders;
}

function requireProvisionResult(value: unknown): SyncGatewayProvisionResult {
  const record = requireRecord(value, "provisionRegistry result");
  if (!Array.isArray(record.registrations)) {
    return invalidGatewayResponse("provisionRegistry result registrations must be an array");
  }
  return {
    registrations: record.registrations.map(requireProvisionRoute),
    createdSheets: requireStringArray(
      record.createdSheets,
      "provisionRegistry result createdSheets",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    initializedHeaders: requireStringArray(
      record.initializedHeaders,
      "provisionRegistry result initializedHeaders",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
  };
}

/**
 * Rejects an outdated gateway deployment that silently ignores a declared
 * checkbox control. A ready response must prove the same UI contract that
 * SQLite signed into the provisioning request.
 */
function requireProvisionedCheckboxControls(
  requested: readonly SyncGatewayProvisionRegistration[],
  result: SyncGatewayProvisionResult,
): void {
  for (const registration of requested) {
    const expected = registration.checkboxHeaders ?? [];
    if (expected.length === EMPTY_ARRAY_LENGTH_ZERO) continue;
    const returned = result.registrations.find((candidate) =>
      candidate.sheetName === registration.sheetName &&
      candidate.registeredRange === registration.registeredRange &&
      candidate.projection === registration.projection &&
      candidate.schemaVersion === registration.schemaVersion,
    );
    const actual = returned?.checkboxHeaders ?? [];
    if (!sameStringArray(expected, actual)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
        `Apps Script sync gateway did not confirm checkbox controls for ${registration.sheetName}; deploy the matching gateway source before provisioning.`,
      );
    }
  }
}

function requireProvisionRoute(
  value: unknown,
): Omit<SyncGatewayProvisionRegistration, "headers"> {
  const record = requireRecord(value, "provisionRegistry result registration");
  const sheetName = requireSyncGatewayText(
    record.sheetName,
    "provisionRegistry result registration sheetName",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  const registeredRange = normalizeWholeColumnRange(
    record.registeredRange,
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  const projection = requireSyncGatewayProjection(
    record.projection,
    "provisionRegistry result registration projection",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  const schemaVersion = requireSyncGatewayPositiveSafeInteger(
    record.schemaVersion,
    "provisionRegistry result registration schemaVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  const checkboxHeaders = record.checkboxHeaders === undefined
    ? undefined
    : requireStringArray(
      record.checkboxHeaders,
      "provisionRegistry result registration checkboxHeaders",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    );
  return {
    sheetName,
    registeredRange,
    projection,
    schemaVersion,
    ...(checkboxHeaders === undefined ? {} : { checkboxHeaders }),
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeWholeColumnRange(value: unknown, errorCode: typeof SYNC_GATEWAY_ERROR_CODES[keyof typeof SYNC_GATEWAY_ERROR_CODES]): string {
  const text = requireSyncGatewayText(value, "sync gateway registered range", errorCode);
  const normalized = text.trim().toUpperCase();
  const match = /^([A-Z]+):([A-Z]+)$/.exec(normalized);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    columnNumber(match[2]) < columnNumber(match[1])
  ) {
    throw new SyncGatewayContractError(
      errorCode,
      "sync gateway provisioning range must be a whole-column range such as A:Z",
    );
  }
  return normalized;
}

function columnCount(registeredRange: string): number {
  const [start, end] = registeredRange.split(":");
  if (start === undefined || end === undefined) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      "sync gateway provisioning range must be a whole-column range such as A:Z",
    );
  }
  return columnNumber(end) - columnNumber(start) + POSITIVE_SAFE_INTEGER_MINIMUM;
}

function columnNumber(letters: string): number {
  let value = EMPTY_ARRAY_LENGTH_ZERO;
  for (const letter of letters) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return value;
}

function requireAnchorResult(value: unknown): EnsureSyncRowAnchorsResult {
  const record = requireRecord(value, "ensureRowAnchors result");
  return {
    assigned: requireSyncGatewayNonNegativeSafeInteger(
      record.assigned,
      "ensureRowAnchors result assigned",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    existing: requireSyncGatewayNonNegativeSafeInteger(
      record.existing,
      "ensureRowAnchors result existing",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    duplicateAnchors: requireDuplicateAnchors(record.duplicateAnchors),
  };
}

function requireSnapshot(value: unknown): SyncGatewaySnapshot {
  const record = requireRecord(value, "snapshot result");
  if (!Array.isArray(record.rows)) {
    return invalidGatewayResponse("snapshot result rows must be an array");
  }
  return {
    protocolVersion: requireSyncGatewayProtocolVersion(
      record.protocolVersion,
      "snapshot result protocolVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    sheetName: requireSyncGatewayText(
      record.sheetName,
      "snapshot result sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    registeredRange: requireSyncGatewayText(
      record.registeredRange,
      "snapshot result registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    projection: requireSyncGatewayProjection(
      record.projection,
      "snapshot result projection",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    schemaVersion: requireSyncGatewayPositiveSafeInteger(
      record.schemaVersion,
      "snapshot result schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    headers: requireStringArray(
      record.headers,
      "snapshot result headers",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    rows: record.rows.map(requireSnapshotRow),
    snapshotHash: requireSyncGatewayText(
      record.snapshotHash,
      "snapshot result snapshotHash",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    unanchoredRows: requirePositiveSafeIntegerArray(
      record.unanchoredRows,
      "snapshot result unanchoredRows",
    ),
    duplicateAnchors: requireDuplicateAnchors(record.duplicateAnchors),
  };
}

function requireApplyResult(value: unknown): ApplySyncEffectsResult {
  const record = requireRecord(value, "applyEffects result");
  if (!Array.isArray(record.results)) {
    return invalidGatewayResponse("applyEffects result results must be an array");
  }
  return {
    results: record.results.map(requireEffectResult),
    snapshotHash: requireNullableString(
      record.snapshotHash,
      "applyEffects result snapshotHash",
    ),
    hasMore: requireBoolean(record.hasMore, "applyEffects result hasMore"),
  };
}

/** Validates receipt-backed deletion evidence returned after a lost gateway response. */
function requireEffectPostcondition(value: unknown): SyncEffectPostcondition {
  const record = requireRecord(value, "effect postcondition");
  return {
    disposition: requirePostconditionDisposition(record.disposition),
    visibleRevision: requireNullableNonNegativeInteger(
      record.visibleRevision,
      "effect postcondition visibleRevision",
    ),
    visibleHash: requireNullableString(
      record.visibleHash,
      "effect postcondition visibleHash",
    ),
    snapshotHash: requireNullableString(
      record.snapshotHash,
      "effect postcondition snapshotHash",
    ),
  };
}

function requireSnapshotRow(value: unknown): SyncSnapshotRow {
  const record = requireRecord(value, "snapshot result row");
  const cellsRecord = requireRecord(record.cells, "snapshot result row cells");
  const cells: Record<string, SyncSnapshotCell> = {};
  for (const [fieldName, cell] of Object.entries(cellsRecord)) {
    cells[fieldName] = requireSnapshotCell(cell, `snapshot result row cell ${fieldName}`);
  }
  return {
    rowNumber: requireSyncGatewayPositiveSafeInteger(
      record.rowNumber,
      "snapshot result row rowNumber",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    physicalAnchor: requireNullableString(
      record.physicalAnchor,
      "snapshot result row physicalAnchor",
    ),
    visibleRevision: requireNullableNonNegativeInteger(
      record.visibleRevision,
      "snapshot result row visibleRevision",
    ),
    visibleHash: requireNullableString(
      record.visibleHash,
      "snapshot result row visibleHash",
    ),
    cells,
  };
}

function requireSnapshotCell(value: unknown, label: string): SyncSnapshotCell {
  const record = requireRecord(value, label);
  return {
    cellKind: requireCellKind(record.cellKind, `${label} cellKind`),
    normalizedCell: requireNormalizedCell(record.normalizedCell, `${label} normalizedCell`),
    formulaHash: requireNullableString(record.formulaHash, `${label} formulaHash`),
    mergeRange: requireNullableString(record.mergeRange, `${label} mergeRange`),
    errorCode: requireNullableString(record.errorCode, `${label} errorCode`),
    stableHash: requireNullableString(record.stableHash, `${label} stableHash`),
  };
}

function requireEffectResult(value: unknown): ApplySyncEffectsResult["results"][number] {
  const record = requireRecord(value, "applyEffects result effect");
  return {
    effectId: requireSyncGatewayText(
      record.effectId,
      "applyEffects result effectId",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    payloadHash: requireSyncGatewayText(
      record.payloadHash,
      "applyEffects result payloadHash",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    status: requireEffectStatus(record.status),
    visibleRevision: requireNullableNonNegativeInteger(
      record.visibleRevision,
      "applyEffects result visibleRevision",
    ),
    visibleHash: requireNullableString(
      record.visibleHash,
      "applyEffects result visibleHash",
    ),
    snapshotHash: requireNullableString(
      record.snapshotHash,
      "applyEffects result snapshotHash",
    ),
    reason: requireNullableString(record.reason, "applyEffects result reason"),
    postcondition: requirePostconditionStatus(record.postcondition),
  };
}

function requireDuplicateAnchors(
  value: unknown,
): readonly { readonly anchor: string; readonly rowNumbers: readonly number[] }[] {
  if (!Array.isArray(value)) {
    return invalidGatewayResponse("duplicateAnchors must be an array");
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `duplicateAnchors[${index}]`);
    return {
      anchor: requireSyncGatewayText(
        record.anchor,
        `duplicateAnchors[${index}] anchor`,
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      rowNumbers: requirePositiveSafeIntegerArray(
        record.rowNumbers,
        `duplicateAnchors[${index}] rowNumbers`,
      ),
    };
  });
}

function parseGatewayResponse(
  text: string,
  status: Presence<number>,
):
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Apps Script sync gateway did not return JSON",
      status,
    );
  }
  if (!isRecord(parsed) || !isBoolean(parsed.ok)) {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Apps Script sync gateway returned an invalid response",
      status,
    );
  }
  if (parsed.ok === true && "result" in parsed) {
    return { ok: true, result: parsed.result };
  }
  if (
    parsed.ok === false &&
    isRecord(parsed.error) &&
    isString(parsed.error.code) &&
    isString(parsed.error.message)
  ) {
    return {
      ok: false,
      error: { code: parsed.error.code, message: parsed.error.message },
    };
  }
  throw new AppsScriptSyncGatewayError(
    SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
    "Apps Script sync gateway returned an invalid response",
    status,
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) return invalidGatewayResponse(`${label} must be an object`);
  return value;
}

function requireStringArray(
  value: unknown,
  label: string,
  errorCode: typeof SYNC_GATEWAY_ERROR_CODES[keyof typeof SYNC_GATEWAY_ERROR_CODES],
): string[] {
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new SyncGatewayContractError(errorCode, `${label} must be a string array`);
  }
  return [...value];
}

function requireUniqueStrings(
  values: readonly string[],
  label: string,
  errorCode: typeof SYNC_GATEWAY_ERROR_CODES[keyof typeof SYNC_GATEWAY_ERROR_CODES],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new SyncGatewayContractError(errorCode, `${label} must be unique`);
    }
    seen.add(value);
  }
}

function requireNonBlankText(
  value: unknown,
  label: string,
  errorCode: typeof SYNC_GATEWAY_ERROR_CODES[keyof typeof SYNC_GATEWAY_ERROR_CODES],
): string {
  const text = requireSyncGatewayText(value, label, errorCode);
  if (text.trim().length === EMPTY_STRING_LENGTH_ZERO) {
    throw new SyncGatewayContractError(errorCode, `${label} is required`);
  }
  return text;
}

function requireNullableString(value: unknown, label: string): Presence<string> {
  if (value === null) return absentValue();
  return presentValue(requireSyncGatewayText(
    value,
    label,
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  ));
}

function requireNullableNonNegativeInteger(value: unknown, label: string): Presence<number> {
  if (value === null) return absentValue();
  return presentValue(requireSyncGatewayNonNegativeSafeInteger(
    value,
    label,
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  ));
}

function requirePositiveSafeIntegerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) return invalidGatewayResponse(`${label} must be an array`);
  return value.map((entry, index) => requireSyncGatewayPositiveSafeInteger(
    entry,
    `${label}[${index}]`,
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  ));
}

function requireBoolean(value: unknown, label: string): boolean {
  if (!isBoolean(value)) return invalidGatewayResponse(`${label} must be boolean`);
  return value;
}

function requireCellKind(value: unknown, label: string): CellObservationKind {
  if (!isString(value) || !isCellKind(value)) {
    return invalidGatewayResponse(`${label} is invalid`);
  }
  return value;
}

function requireEffectStatus(value: unknown): SyncGatewayEffectResultStatus {
  if (!isString(value) || !isEffectStatus(value)) {
    return invalidGatewayResponse("applyEffects result status is invalid");
  }
  return value;
}

function requirePostconditionStatus(value: unknown): SyncGatewayPostconditionStatus {
  if (!isString(value) || !isPostconditionStatus(value)) {
    return invalidGatewayResponse("applyEffects result postcondition is invalid");
  }
  return value;
}

function requirePostconditionDisposition(value: unknown): SyncGatewayPostconditionDisposition {
  if (!isString(value) || !isPostconditionDisposition(value)) {
    return invalidGatewayResponse("effect postcondition disposition is invalid");
  }
  return value;
}

function requireNormalizedCell(value: unknown, label: string): NormalizedCell {
  if (!isNormalizedCell(value)) return invalidGatewayResponse(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT) &&
    value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING);
}

function isBoolean(value: unknown): value is boolean {
  return isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.BOOLEAN);
}

function isCellKind(value: string): value is CellObservationKind {
  return Object.values(CELL_OBSERVATION_KINDS).includes(value as CellObservationKind);
}

function isEffectStatus(value: string): value is SyncGatewayEffectResultStatus {
  return Object.values(SYNC_GATEWAY_EFFECT_RESULT_STATUSES).includes(
    value as SyncGatewayEffectResultStatus,
  );
}

function isPostconditionStatus(value: string): value is SyncGatewayPostconditionStatus {
  return Object.values(SYNC_GATEWAY_POSTCONDITION_STATUSES).includes(
    value as SyncGatewayPostconditionStatus,
  );
}

function isPostconditionDisposition(value: string): value is SyncGatewayPostconditionDisposition {
  return Object.values(SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS).includes(
    value as SyncGatewayPostconditionDisposition,
  );
}

/** `null` is an actual empty-cell value at the JSON wire boundary. */
function isNormalizedCell(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === NORMALIZED_CELL_KINDS.STRING) {
    return isString(value.value);
  }
  if (value.kind === NORMALIZED_CELL_KINDS.NUMBER) {
    return isJavaScriptType(value.value, JAVASCRIPT_TYPE_NAMES.NUMBER) &&
      Number.isFinite(value.value);
  }
  if (value.kind === NORMALIZED_CELL_KINDS.BOOLEAN) {
    return isBoolean(value.value);
  }
  return value.kind === NORMALIZED_CELL_KINDS.DATE && isString(value.value);
}

function requireRequestTimeout(value: unknown): number {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER) ||
    !Number.isSafeInteger(value) ||
    value < SYNC_GATEWAY_CLIENT_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
    value > SYNC_GATEWAY_CLIENT_DEFAULTS.MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_CLIENT_OPTIONS,
      "Apps Script sync gateway timeout must be between 1 second and 120 seconds",
    );
  }
  return value;
}

function toWireGatewayPayload(
  operation: SyncGatewayOperation,
  payload: SyncGatewayRequestPayload,
): SyncJsonValue {
  if (operation === SYNC_GATEWAY_OPERATIONS.APPLY_EFFECTS) {
    if (!isApplySyncEffectsRequest(payload)) {
      return invalidGatewayResponse("applyEffects request payload is invalid");
    }
    return toWireApplyEffectsRequest(payload);
  }
  if (operation === SYNC_GATEWAY_OPERATIONS.READ_EFFECT_POSTCONDITION) {
    if (!isReadEffectPostconditionRequest(payload)) {
      return invalidGatewayResponse(
        "readEffectPostcondition request payload is invalid",
      );
    }
    return toWireEffectPostconditionRequest(payload);
  }
  return toWireAnchorRequest(payload);
}

type SyncGatewayRequestPayload =
  | EnsureSyncRowAnchorsRequest
  | ApplySyncEffectsRequest
  | ReadEffectPostconditionRequest;

interface ReadEffectPostconditionRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effect: SyncGatewayEffect;
}

function toWireAnchorRequest(request: EnsureSyncRowAnchorsRequest): SyncJsonValue {
  return {
    physicalSheetId: request.physicalSheetId,
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
  };
}

function isApplySyncEffectsRequest(
  value: SyncGatewayRequestPayload,
): value is ApplySyncEffectsRequest {
  return "effects" in value;
}

function isReadEffectPostconditionRequest(
  value: SyncGatewayRequestPayload,
): value is ReadEffectPostconditionRequest {
  return "effect" in value;
}

function toWireApplyEffectsRequest(request: ApplySyncEffectsRequest): SyncJsonValue {
  return {
    physicalSheetId: request.physicalSheetId,
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    effects: request.effects.map(toWireEffect),
  };
}

function toWireEffectPostconditionRequest(
  request: ReadEffectPostconditionRequest,
): SyncJsonValue {
  return {
    physicalSheetId: request.physicalSheetId,
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    effect: toWireEffect(request.effect),
  };
}

function toWireEffect(effect: SyncGatewayEffect): SyncJsonValue {
  return {
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    effectKind: effect.effectKind,
    physicalSheetId: effect.physicalSheetId,
    projection: effect.projection,
    targetKind: effect.targetKind,
    targetId: effect.targetId,
    rowBindingId: toNullablePresence(effect.rowBindingId),
    conflictId: toNullablePresence(effect.conflictId),
    expectedVisibleRevision: effect.expectedVisibleRevision,
    expectedVisibleHash: effect.expectedVisibleHash,
    repairGuardHash: toNullablePresence(effect.repairGuardHash),
    payload: {
      sheetName: effect.payload.sheetName,
      registeredRange: effect.payload.registeredRange,
      schemaVersion: effect.payload.schemaVersion,
      targetAnchor: effect.payload.targetAnchor,
      fields: toWireNormalizedFields(effect.payload.fields),
      targetVisibleHash: effect.payload.targetVisibleHash,
      createIfMissing: effect.payload.createIfMissing,
      expectedCandidateHash: toNullableApplicability(effect.payload.expectedCandidateHash),
    },
  };
}

function toWireNormalizedFields(
  fields: Readonly<Record<string, NormalizedCell>>,
): SyncJsonValue {
  return Object.fromEntries(
    Object.entries(fields).map(([fieldName, value]) => [
      fieldName,
      toWireNormalizedCell(value),
    ]),
  );
}

function toWireNormalizedCell(value: NormalizedCell): SyncJsonValue {
  if (value === null) return null;
  return {
    kind: value.kind,
    value: value.value,
  };
}

function toNullablePresence<T>(value: Presence<T>): T | null {
  return value.kind === PRESENCE_KINDS.PRESENT ? value.value : null;
}

function toNullableApplicability<T>(value: Applicability<T>): T | null {
  return value.kind === APPLICABILITY_KINDS.APPLICABLE ? value.value : null;
}

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function unavailablePostcondition(): SyncEffectPostcondition {
  return {
    disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
    visibleRevision: absentValue(),
    visibleHash: absentValue(),
    snapshotHash: absentValue(),
  };
}

function invalidGatewayResponse(message: string): never {
  throw new SyncGatewayContractError(
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    message,
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown request failure";
}
