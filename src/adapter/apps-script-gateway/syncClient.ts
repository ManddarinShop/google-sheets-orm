/** Client adapter for the registry-bound Apps Script sync gateway. */

import {
  computeSyncVisibleHash,
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
import {
  createSyncGatewayEnvelope,
  type SyncGatewayEnvelope,
  type SyncGatewayOperation,
  type SyncJsonValue,
} from "./syncProtocol.js";
import {
  createSyncGatewayAdminEnvelope,
  type SyncGatewayAdminEnvelope,
} from "./syncAdminProtocol.js";

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
export interface SyncGatewayProvisionRegistration {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: "user_input" | "system_state" | "sync_conflicts";
  readonly schemaVersion: number;
  /** Exact header row; an existing non-matching header is never overwritten. */
  readonly headers: readonly string[];
  /**
   * User-editable boolean control columns rendered as Google Sheets checkboxes.
   * They are allowed only on the Sync_Conflicts control projection and must
   * name exact headers from this registration.
   */
  readonly checkboxHeaders?: readonly string[];
}

/** Evidence returned after the gateway creates or verifies a projection registry. */
export interface SyncGatewayProvisionResult {
  readonly registrations: readonly Omit<SyncGatewayProvisionRegistration, "headers">[];
  readonly createdSheets: readonly string[];
  readonly initializedHeaders: readonly string[];
}

/** Error with a gateway error code safe to report to an operator. */
export class AppsScriptSyncGatewayError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "AppsScriptSyncGatewayError";
  }
}

/**
 * Implements the sync runtime gateway contract over the signed Apps Script API.
 *
 * The client does not accept an arbitrary sheet name at its public boundary:
 * each call carries the physical registry record selected by the local runtime.
 */
export class AppsScriptSyncGatewayClient implements SyncSheetGateway {
  private readonly url: string;
  private readonly secret: string;
  private readonly sheetId: string;
  private readonly keyId: string;
  private readonly actorId: string;
  private readonly requestTimeoutMs: number;

  public constructor(options: AppsScriptSyncGatewayClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "https:") throw new Error("Apps Script sync gateway URL must use HTTPS");
    if (options.secret.length === 0 || options.sheetId.length === 0) {
      throw new Error("Apps Script sync gateway secret and sheet ID are required");
    }
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
      throw new Error("Apps Script sync gateway timeout must be between 1 second and 120 seconds");
    }
    this.url = url.toString();
    this.secret = options.secret;
    this.sheetId = options.sheetId;
    this.keyId = options.keyId ?? "typed-sheets-shared-secret-v1";
    this.actorId = options.actorId ?? "typed-sheets-sync-worker";
    this.requestTimeoutMs = timeout;
  }

  public async ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    const result = await this.invoke("ensureRowAnchors", request.registeredRange, request);
    return requireAnchorResult(result);
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    const result = await this.invoke("readSnapshot", request.registeredRange, request);
    return requireSnapshot(result);
  }

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    const result = await this.invoke("applyEffects", request.registeredRange, request);
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
    const payload = { registrations: normalized };
    const envelope = createSyncGatewayAdminEnvelope({
      operation: "provisionRegistry",
      payload: payload as unknown as SyncJsonValue,
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
    if (effect.effectKind === "resolution_delete") {
      try {
        const result = await this.invoke("readEffectPostcondition", effect.payload.registeredRange, {
          physicalSheetId: effect.physicalSheetId,
          sheetName: effect.payload.sheetName,
          registeredRange: effect.payload.registeredRange,
          projection: effect.projection,
          schemaVersion: effect.payload.schemaVersion,
          effect,
        });
        return requireEffectPostcondition(result);
      } catch {
        return { disposition: "unavailable", visibleRevision: null, visibleHash: null, snapshotHash: null };
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
      const row = snapshot.rows.find((candidate) => candidate.physicalAnchor === effect.payload.targetAnchor);
      if (row === undefined) {
        return {
          disposition: effect.payload.createIfMissing ? "unapplied" : "changed",
          visibleRevision: null,
          visibleHash: null,
          snapshotHash: snapshot.snapshotHash,
        };
      }
      const fields: Record<string, SyncSnapshotCell["normalizedCell"]> = {};
      for (const fieldName of Object.keys(effect.payload.fields)) {
        const cell = row.cells[fieldName];
        if (cell === undefined) {
          return {
            disposition: "changed",
            visibleRevision: row.visibleRevision,
            visibleHash: row.visibleHash,
            snapshotHash: snapshot.snapshotHash,
          };
        }
        fields[fieldName] = cell.normalizedCell;
      }
      const actualHash = computeSyncVisibleHash(fields);
      const visibleHash = row.visibleHash ?? actualHash;
      const common = {
        visibleRevision: row.visibleRevision,
        visibleHash,
        snapshotHash: snapshot.snapshotHash,
      };
      if (actualHash === effect.payload.targetVisibleHash) return { disposition: "applied", ...common };
      if (actualHash === effect.expectedVisibleHash || actualHash === effect.repairGuardHash) {
        return { disposition: "unapplied", ...common };
      }
      return { disposition: "changed", ...common };
    } catch {
      return { disposition: "unavailable", visibleRevision: null, visibleHash: null, snapshotHash: null };
    }
  }

  private async invoke(
    operation: SyncGatewayOperation,
    registeredRange: string,
    payload: unknown,
  ): Promise<unknown> {
    const envelope = createSyncGatewayEnvelope({
      operation,
      payload: payload as SyncJsonValue,
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
      const decoded = parseGatewayResponse(text, response.status);
      if (!response.ok) {
        throw new AppsScriptSyncGatewayError(
          decoded.ok ? "Gateway returned HTTP " + response.status : decoded.error.message,
          decoded.ok ? "http_error" : decoded.error.code,
          response.status,
        );
      }
      if (!decoded.ok) {
        throw new AppsScriptSyncGatewayError(decoded.error.message, decoded.error.code, response.status);
      }
      return decoded.result;
    } catch (error: unknown) {
      if (error instanceof AppsScriptSyncGatewayError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppsScriptSyncGatewayError("Apps Script sync gateway request timed out", "timeout", null);
      }
      throw new AppsScriptSyncGatewayError(
        "Apps Script sync gateway request failed: " + safeMessage(error),
        "network_error",
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeProvisionRegistrations(
  registrations: readonly SyncGatewayProvisionRegistration[],
): SyncGatewayProvisionRegistration[] {
  if (registrations.length === 0) {
    throw new Error("sync gateway provisioning requires at least one registration");
  }

  const seenSheets = new Set<string>();
  return registrations.map((registration) => {
    if (registration.sheetName.trim().length === 0) {
      throw new Error("sync gateway provisioning sheetName is required");
    }
    if (seenSheets.has(registration.sheetName)) {
      throw new Error("sync gateway provisioning cannot register one tab more than once");
    }
    seenSheets.add(registration.sheetName);

    const registeredRange = normalizeWholeColumnRange(registration.registeredRange);
    if (!isProjection(registration.projection)) {
      throw new Error("sync gateway provisioning has an unsupported projection");
    }
    if (!isPositiveInteger(registration.schemaVersion)) {
      throw new Error("sync gateway provisioning schemaVersion must be a positive safe integer");
    }
    if (registration.headers.length !== columnCount(registeredRange)) {
      throw new Error("sync gateway provisioning headers must exactly match the registered range");
    }

    const seenHeaders = new Set<string>();
    const headers = registration.headers.map((header) => {
      if (typeof header !== "string" || header.trim().length === 0) {
        throw new Error("sync gateway provisioning headers must be non-empty text");
      }
      if (seenHeaders.has(header)) {
        throw new Error("sync gateway provisioning headers must be unique");
      }
      seenHeaders.add(header);
      return header;
    });
    const checkboxHeaders = normalizeCheckboxHeaders(
      registration.checkboxHeaders,
      registration.projection,
      headers,
    );
    return {
      sheetName: registration.sheetName,
      registeredRange,
      projection: registration.projection,
      schemaVersion: registration.schemaVersion,
      headers,
      ...(checkboxHeaders.length === 0 ? {} : { checkboxHeaders }),
    };
  });
}

/** Validates the small UI-control surface exposed by a Sync_Conflicts projection. */
function normalizeCheckboxHeaders(
  value: readonly string[] | undefined,
  projection: SyncGatewayProvisionRegistration["projection"],
  headers: readonly string[],
): string[] {
  if (value === undefined || value.length === 0) return [];
  if (projection !== "sync_conflicts") {
    throw new Error("sync gateway provisioning checkbox headers are only allowed on sync_conflicts");
  }
  const knownHeaders = new Set(headers);
  const seen = new Set<string>();
  return value.map((header) => {
    if (typeof header !== "string" || header.trim().length === 0) {
      throw new Error("sync gateway provisioning checkbox headers must be non-empty text");
    }
    if (!knownHeaders.has(header)) {
      throw new Error("sync gateway provisioning checkbox headers must be declared headers");
    }
    if (seen.has(header)) {
      throw new Error("sync gateway provisioning checkbox headers must be unique");
    }
    seen.add(header);
    return header;
  });
}

function requireProvisionResult(value: unknown): SyncGatewayProvisionResult {
  const record = requireRecord(value, "provisionRegistry result");
  if (
    !Array.isArray(record.registrations) || !record.registrations.every(isProvisionRoute) ||
    !isStringArray(record.createdSheets) || !isStringArray(record.initializedHeaders)
  ) {
    throw new Error("Apps Script sync gateway returned an invalid provisionRegistry result");
  }
  return {
    registrations: record.registrations,
    createdSheets: record.createdSheets,
    initializedHeaders: record.initializedHeaders,
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
    if (expected.length === 0) continue;
    const returned = result.registrations.find((candidate) =>
      candidate.sheetName === registration.sheetName &&
      candidate.registeredRange === registration.registeredRange &&
      candidate.projection === registration.projection &&
      candidate.schemaVersion === registration.schemaVersion,
    );
    const actual = returned?.checkboxHeaders ?? [];
    if (!sameStringArray(expected, actual)) {
      throw new Error(
        `Apps Script sync gateway did not confirm checkbox controls for ${registration.sheetName}; deploy the matching gateway source before provisioning.`,
      );
    }
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isProvisionRoute(value: unknown): value is Omit<SyncGatewayProvisionRegistration, "headers"> {
  return isRecord(value) && typeof value.sheetName === "string" &&
    typeof value.registeredRange === "string" && isProjection(value.projection) &&
    isPositiveInteger(value.schemaVersion) &&
    (value.checkboxHeaders === undefined || isStringArray(value.checkboxHeaders));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeWholeColumnRange(value: string): string {
  const normalized = value.trim().toUpperCase();
  const match = /^([A-Z]+):([A-Z]+)$/.exec(normalized);
  if (match === null || match[1] === undefined || match[2] === undefined ||
    columnNumber(match[2]) < columnNumber(match[1])) {
    throw new Error("sync gateway provisioning range must be a whole-column range such as A:Z");
  }
  return normalized;
}

function columnCount(registeredRange: string): number {
  const [start, end] = registeredRange.split(":");
  if (start === undefined || end === undefined) {
    throw new Error("sync gateway provisioning range must be a whole-column range such as A:Z");
  }
  return columnNumber(end) - columnNumber(start) + 1;
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return value;
}

function requireAnchorResult(value: unknown): EnsureSyncRowAnchorsResult {
  const record = requireRecord(value, "ensureRowAnchors result");
  if (!isNonNegativeInteger(record.assigned) || !isNonNegativeInteger(record.existing)) {
    throw new Error("Apps Script sync gateway returned an invalid anchor result");
  }
  return {
    assigned: record.assigned,
    existing: record.existing,
    duplicateAnchors: requireDuplicateAnchors(record.duplicateAnchors),
  };
}

function requireSnapshot(value: unknown): SyncGatewaySnapshot {
  const record = requireRecord(value, "snapshot result");
  if (
    typeof record.protocolVersion !== "string" ||
    typeof record.sheetName !== "string" ||
    typeof record.registeredRange !== "string" ||
    !isProjection(record.projection) ||
    !isPositiveInteger(record.schemaVersion) ||
    !Array.isArray(record.headers) || !record.headers.every((header) => typeof header === "string") ||
    !Array.isArray(record.rows) || !record.rows.every(isSnapshotRow) ||
    typeof record.snapshotHash !== "string" ||
    !Array.isArray(record.unanchoredRows) || !record.unanchoredRows.every(isPositiveInteger)
  ) {
    throw new Error("Apps Script sync gateway returned an invalid snapshot");
  }
  return {
    protocolVersion: record.protocolVersion,
    sheetName: record.sheetName,
    registeredRange: record.registeredRange,
    projection: record.projection,
    schemaVersion: record.schemaVersion,
    headers: record.headers,
    rows: record.rows,
    snapshotHash: record.snapshotHash,
    unanchoredRows: record.unanchoredRows,
    duplicateAnchors: requireDuplicateAnchors(record.duplicateAnchors),
  };
}

function requireApplyResult(value: unknown): ApplySyncEffectsResult {
  const record = requireRecord(value, "applyEffects result");
  if (!Array.isArray(record.results) || !record.results.every(isEffectResult) ||
    (record.snapshotHash !== null && typeof record.snapshotHash !== "string") ||
    typeof record.hasMore !== "boolean") {
    throw new Error("Apps Script sync gateway returned an invalid applyEffects result");
  }
  return { results: record.results, snapshotHash: record.snapshotHash, hasMore: record.hasMore };
}

/** Validates receipt-backed deletion evidence returned after a lost gateway response. */
function requireEffectPostcondition(value: unknown): SyncEffectPostcondition {
  const record = requireRecord(value, "effect postcondition");
  const disposition = record.disposition;
  if (
    disposition !== "applied" && disposition !== "unapplied" &&
    disposition !== "changed" && disposition !== "unavailable"
  ) {
    throw new Error("Apps Script sync gateway returned an invalid effect postcondition");
  }
  if (
    (record.visibleRevision !== null && !isNonNegativeInteger(record.visibleRevision)) ||
    (record.visibleHash !== null && typeof record.visibleHash !== "string") ||
    (record.snapshotHash !== null && typeof record.snapshotHash !== "string")
  ) {
    throw new Error("Apps Script sync gateway returned invalid effect postcondition evidence");
  }
  return {
    disposition,
    visibleRevision: record.visibleRevision,
    visibleHash: record.visibleHash,
    snapshotHash: record.snapshotHash,
  };
}

function isSnapshotRow(value: unknown): value is SyncSnapshotRow {
  if (!isRecord(value) || !isPositiveInteger(value.rowNumber) ||
    (value.physicalAnchor !== null && typeof value.physicalAnchor !== "string") ||
    (value.visibleRevision !== null && !isNonNegativeInteger(value.visibleRevision)) ||
    (value.visibleHash !== null && typeof value.visibleHash !== "string") ||
    !isRecord(value.cells)) return false;
  return Object.values(value.cells).every(isSnapshotCell);
}

function isSnapshotCell(value: unknown): value is SyncSnapshotCell {
  if (!isRecord(value) || !isCellKind(value.cellKind) ||
    (value.formulaHash !== null && typeof value.formulaHash !== "string") ||
    (value.mergeRange !== null && typeof value.mergeRange !== "string") ||
    (value.errorCode !== null && typeof value.errorCode !== "string") ||
    (value.stableHash !== null && typeof value.stableHash !== "string")) return false;
  return isNormalizedCell(value.normalizedCell);
}

function isEffectResult(value: unknown): value is ApplySyncEffectsResult["results"][number] {
  if (!isRecord(value) || typeof value.effectId !== "string" || typeof value.payloadHash !== "string" ||
    !isEffectStatus(value.status) ||
    (value.visibleRevision !== null && !isNonNegativeInteger(value.visibleRevision)) ||
    (value.visibleHash !== null && typeof value.visibleHash !== "string") ||
    (value.snapshotHash !== null && typeof value.snapshotHash !== "string") ||
    (value.reason !== null && typeof value.reason !== "string") ||
    (value.postcondition !== "verified" && value.postcondition !== "unavailable")) return false;
  return true;
}

function requireDuplicateAnchors(value: unknown): readonly { readonly anchor: string; readonly rowNumbers: readonly number[] }[] {
  if (!Array.isArray(value) || !value.every((entry) =>
    isRecord(entry) && typeof entry.anchor === "string" && Array.isArray(entry.rowNumbers) &&
    entry.rowNumbers.every(isPositiveInteger)
  )) {
    throw new Error("Apps Script sync gateway returned invalid duplicate-anchor evidence");
  }
  return value as readonly { readonly anchor: string; readonly rowNumbers: readonly number[] }[];
}

function parseGatewayResponse(text: string, status: number):
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AppsScriptSyncGatewayError("Apps Script sync gateway did not return JSON", "invalid_response", status);
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    throw new AppsScriptSyncGatewayError("Apps Script sync gateway returned an invalid response", "invalid_response", status);
  }
  if (parsed.ok === true && "result" in parsed) return { ok: true, result: parsed.result };
  if (parsed.ok === false && isRecord(parsed.error) &&
    typeof parsed.error.code === "string" && typeof parsed.error.message === "string") {
    return { ok: false, error: { code: parsed.error.code, message: parsed.error.message } };
  }
  throw new AppsScriptSyncGatewayError("Apps Script sync gateway returned an invalid response", "invalid_response", status);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(label + " must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjection(value: unknown): value is "user_input" | "system_state" | "sync_conflicts" {
  return value === "user_input" || value === "system_state" || value === "sync_conflicts";
}

function isCellKind(value: unknown): boolean {
  return value === "blank" || value === "literal" || value === "formula" || value === "merged" || value === "error";
}

function isEffectStatus(value: unknown): boolean {
  return value === "applied" || value === "already_applied" || value === "superseded" ||
    value === "guard_mismatch" || value === "repair_reobserve" || value === "schema_error" ||
    value === "retryable_error";
}

function isNormalizedCell(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "string") return typeof value.value === "string";
  if (value.kind === "number") return typeof value.value === "number" && Number.isFinite(value.value);
  if (value.kind === "boolean") return typeof value.value === "boolean";
  return value.kind === "date" && typeof value.value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown request failure";
}
