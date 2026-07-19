/**
 * Shared gateway contract for the SQLite-authoritative sync runtime.
 *
 * The contract deliberately contains normalized values and stable anchors,
 * never Google SDK objects or physical row numbers.  Both the fake gateway and
 * the Apps Script client implement this boundary so fault tests exercise the
 * same compare-and-set semantics as a deployed gateway.
 */

import { stableHash, type NormalizedCell } from "../../core/index.js";

/** Projections supported by the v1 sync gateway. */
export type SyncProjection = "user_input" | "system_state" | "sync_conflicts";

/** Effect classes whose compare-and-set behavior differs at the gateway. */
export type SyncEffectKind =
  | "system_projection"
  | "candidate_reconcile"
  | "system_repair"
  | "resolution_projection"
  /** Deletes one resolved Sync_Conflicts row after confirming its full visible state. */
  | "resolution_delete";

/** Literal/formula metadata retained by a normalized Sheet snapshot. */
export interface SyncSnapshotCell {
  readonly cellKind: "blank" | "literal" | "formula" | "merged" | "error";
  readonly normalizedCell: NormalizedCell;
  readonly formulaHash: string | null;
  readonly mergeRange: string | null;
  readonly errorCode: string | null;
  readonly stableHash: string | null;
}

/** One physical row read from a registered projection. */
export interface SyncSnapshotRow {
  readonly rowNumber: number;
  readonly physicalAnchor: string | null;
  /** Projection metadata; null when a legacy/user row has never been materialized. */
  readonly visibleRevision: number | null;
  readonly visibleHash: string | null;
  readonly cells: Readonly<Record<string, SyncSnapshotCell>>;
}

/** Metadata-rich, lock-free snapshot returned by a gateway. */
export interface SyncGatewaySnapshot {
  readonly protocolVersion: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly rows: readonly SyncSnapshotRow[];
  readonly snapshotHash: string;
  readonly unanchoredRows: readonly number[];
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
}

/** Request used to assign missing Developer Metadata anchors before a snapshot. */
export interface EnsureSyncRowAnchorsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
}

/** Result of one anchor assignment pass. */
export interface EnsureSyncRowAnchorsResult {
  readonly assigned: number;
  readonly existing: number;
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
}

/** Lock-free snapshot request. */
export interface ReadSyncSnapshotRequest extends EnsureSyncRowAnchorsRequest {}

/**
 * Serializable projection values written by one outbox effect.
 *
 * `targetVisibleHash` is computed over `fields` with
 * computeSyncVisibleHash().  The anchor is projection-local: User_Input and
 * System_State may represent the same row binding with different anchors.
 */
export interface SyncProjectionEffectPayload {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly targetVisibleHash: string;
  readonly createIfMissing: boolean;
  /** A candidate reconcile must fail rather than overwrite an active candidate. */
  readonly expectedCandidateHash: string | null;
}

/** Gateway-ready view of one durable outbox row. */
export interface SyncGatewayEffect {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly effectKind: SyncEffectKind;
  readonly physicalSheetId: string;
  readonly projection: SyncProjection;
  readonly targetKind: string;
  readonly targetId: string;
  readonly rowBindingId: string | null;
  readonly conflictId: string | null;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: string | null;
  readonly payload: SyncProjectionEffectPayload;
}

/** Per-effect terminal/non-terminal gateway result. */
export interface SyncGatewayEffectResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status:
    | "applied"
    | "already_applied"
    | "superseded"
    | "guard_mismatch"
    | "repair_reobserve"
    | "schema_error"
    | "retryable_error";
  readonly visibleRevision: number | null;
  readonly visibleHash: string | null;
  readonly snapshotHash: string | null;
  readonly reason: string | null;
  readonly postcondition: "verified" | "unavailable";
}

/** Gateway batch request. All effects must target the same physical sheet. */
export interface ApplySyncEffectsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncGatewayEffect[];
}

/** A batch may intentionally return only a prefix when its budget is exhausted. */
export interface ApplySyncEffectsResult {
  readonly results: readonly SyncGatewayEffectResult[];
  readonly snapshotHash: string | null;
  /** True only when the gateway intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
}

/** Read-back classification used after a response is lost or a lease expires. */
export interface SyncEffectPostcondition {
  readonly disposition: "applied" | "unapplied" | "changed" | "unavailable";
  readonly visibleRevision: number | null;
  readonly visibleHash: string | null;
  readonly snapshotHash: string | null;
}

/**
 * Small adapter boundary used by the effect worker and observation runtime.
 *
 * The gateway never determines canonical winners or conflict resolution.  It
 * only reads registered ranges and conditionally materializes an effect.
 */
export interface SyncSheetGateway {
  ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult>;
  readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot>;
  applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult>;
  readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition>;
}

/** Computes the stable visible-state hash shared by fake and real gateways. */
export function computeSyncVisibleHash(fields: Readonly<Record<string, NormalizedCell>>): string {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldName, value]) => ({ fieldName, value }));
  return stableHash({ fields: entries });
}

/** Validates and decodes the projection payload stored in a durable outbox row. */
export function parseSyncProjectionEffectPayload(value: string): SyncProjectionEffectPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("effect payload is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("effect payload must be an object");

  const sheetName = requireText(parsed.sheetName, "effect payload sheetName");
  const registeredRange = requireText(parsed.registeredRange, "effect payload registeredRange");
  const targetAnchor = requireText(parsed.targetAnchor, "effect payload targetAnchor");
  const targetVisibleHash = requireText(parsed.targetVisibleHash, "effect payload targetVisibleHash");
  if (!isPositiveSafeInteger(parsed.schemaVersion)) {
    throw new Error("effect payload schemaVersion must be a positive safe integer");
  }
  if (typeof parsed.createIfMissing !== "boolean") {
    throw new Error("effect payload createIfMissing must be boolean");
  }
  if (parsed.expectedCandidateHash !== null && typeof parsed.expectedCandidateHash !== "string") {
    throw new Error("effect payload expectedCandidateHash must be string or null");
  }
  if (!isRecord(parsed.fields)) throw new Error("effect payload fields must be an object");

  const fields: Record<string, NormalizedCell> = {};
  for (const [fieldName, cell] of Object.entries(parsed.fields)) {
    if (fieldName.length === 0 || !isNormalizedCell(cell)) {
      throw new Error("effect payload contains an invalid normalized field");
    }
    fields[fieldName] = cell;
  }
  if (Object.keys(fields).length === 0) throw new Error("effect payload must contain a field");
  if (computeSyncVisibleHash(fields) !== targetVisibleHash) {
    throw new Error("effect payload targetVisibleHash does not match its fields");
  }

  return {
    sheetName,
    registeredRange,
    schemaVersion: parsed.schemaVersion,
    targetAnchor,
    fields,
    targetVisibleHash,
    createIfMissing: parsed.createIfMissing,
    expectedCandidateHash: parsed.expectedCandidateHash,
  };
}

/** Serializes a checked projection payload in a stable key order for outbox use. */
export function serializeSyncProjectionEffectPayload(payload: SyncProjectionEffectPayload): string {
  // Validate before serialization so worker and gateway fail at the same boundary.
  const checked = parseSyncProjectionEffectPayload(JSON.stringify(payload));
  return JSON.stringify({
    sheetName: checked.sheetName,
    registeredRange: checked.registeredRange,
    schemaVersion: checked.schemaVersion,
    targetAnchor: checked.targetAnchor,
    fields: Object.fromEntries(Object.entries(checked.fields).sort(([a], [b]) => a.localeCompare(b))),
    targetVisibleHash: checked.targetVisibleHash,
    createIfMissing: checked.createIfMissing,
    expectedCandidateHash: checked.expectedCandidateHash,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(label + " is required");
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNormalizedCell(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "string") return typeof value.value === "string";
  if (value.kind === "number") return typeof value.value === "number" && Number.isFinite(value.value);
  if (value.kind === "boolean") return typeof value.value === "boolean";
  return value.kind === "date" && typeof value.value === "string";
}
