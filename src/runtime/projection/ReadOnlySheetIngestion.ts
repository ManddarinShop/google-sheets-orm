/**
 * Registry-bound, no-projection-write Sheet observation runtime.
 *
 * It ensures metadata anchors, reads a normalized snapshot, compares it with
 * SQLite's confirmed visible baseline, and appends only raw observation
 * evidence.  It deliberately does not call applyEffects(), evaluate a winner,
 * or infer a delete from a missing polling row.
 */

import { randomUUID } from "node:crypto";
import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type EditorActorSource,
  type LookupResult,
  type ObservationSource,
  type Presence,
} from "../../core/index.js";
import {
  CELL_OBSERVATION_KINDS,
} from "../../core/encoding/constants.js";
import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../core/state/constants.js";
import {
  persistReadOnlySnapshotObservation,
  requireRegisteredSyncSheet,
  type DatabaseSyncLike,
  type FencingContext,
  type ReadOnlySnapshotObservationResult,
  type RegisteredSyncSheet,
} from "../../storage/index.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../storage/errors.js";
import { fromSqlNullable } from "../../storage/sqlite/sqlState.js";
import type {
  SyncGatewaySnapshot,
  SyncSnapshotCell,
  SyncSnapshotRow,
  SyncSheetGateway,
} from "../gateway/syncGateway.js";

/** Runtime classifications for one read-only shadow diff row. */
export const SHADOW_DIFF_KINDS = {
  UNCHANGED: "unchanged",
  CHANGED: "changed",
  UNBOUND: "unbound",
  MISSING_UNKNOWN: "missing_unknown",
  UNSAFE_SNAPSHOT: "unsafe_snapshot",
} as const;

/** Diff classification that never turns a missing anchor into an automatic delete. */
export type ShadowDiffKind =
  (typeof SHADOW_DIFF_KINDS)[keyof typeof SHADOW_DIFF_KINDS];

const SHADOW_DIFF_REASONS = {
  UNANCHORED_ROW: "unanchored_row",
  DUPLICATE_ANCHOR: "duplicate_anchor",
  UNSUPPORTED_CELL_METADATA: "unsupported_cell_metadata",
  ANCHOR_HAS_NO_ROW_BINDING: "anchor_has_no_row_binding",
  POLLING_CANNOT_PROVE_DELETE: "polling_cannot_prove_delete",
} as const;

type ShadowDiffReason =
  (typeof SHADOW_DIFF_REASONS)[keyof typeof SHADOW_DIFF_REASONS];

const READ_ONLY_INGESTION_SOURCES = {
  POLLING: "polling",
  ON_EDIT: "onEdit",
} as const satisfies Record<string, Extract<ObservationSource, "polling" | "onEdit">>;

type ReadOnlyIngestionSource =
  (typeof READ_ONLY_INGESTION_SOURCES)[keyof typeof READ_ONLY_INGESTION_SOURCES];

const EDITOR_ACTOR_SOURCES = {
  GOOGLE_ACTIVE_USER: "google_active_user",
  UNAVAILABLE: "unavailable",
} as const satisfies Record<string, EditorActorSource>;

const READ_BINDINGS_SQL = `
    SELECT projection.anchor_reference, projection.row_binding_id,
           field.field_name, COALESCE(field.last_observed_field_hash, field.confirmed_field_hash) AS field_hash
    FROM projection_row_binding AS projection
    LEFT JOIN sheet_visible_field_state AS field
      ON field.physical_sheet_id = projection.physical_sheet_id
      AND field.row_binding_id = projection.row_binding_id
    WHERE projection.physical_sheet_id = ? AND projection.row_binding_id IS NOT NULL
    ORDER BY projection.anchor_reference, field.field_name
  `;

/** One row-level observation candidate visible to the next evaluation phase. */
export interface ShadowDiffRow {
  readonly kind: ShadowDiffKind;
  readonly physicalAnchor: Presence<string>;
  readonly rowBindingId: Presence<string>;
  readonly rowNumber: Presence<number>;
  readonly changedFields: readonly string[];
  readonly reason: Presence<ShadowDiffReason>;
}

/** Read-only comparison result for one physical projection. */
export interface ShadowDiff {
  readonly physicalSheetId: string;
  readonly snapshotHash: string;
  readonly rows: readonly ShadowDiffRow[];
  readonly hasChanges: boolean;
  readonly hasUnsafeIdentity: boolean;
}

/** Inputs for one polling/onEdit snapshot ingestion pass. */
export interface ReadOnlySheetIngestionOptions {
  readonly database: DatabaseSyncLike;
  readonly gateway: SyncSheetGateway;
  readonly fence: FencingContext;
  readonly physicalSheetId: string;
  readonly now: number;
  readonly source?: ReadOnlyIngestionSource;
  readonly ingressActorId?: string;
  readonly editorActorId?: Presence<string>;
  readonly editorActorSource?: EditorActorSource;
}

/** Snapshot plus optional durable raw-evidence receipt. */
export interface ReadOnlySheetIngestionResult {
  readonly registration: RegisteredSyncSheet;
  readonly anchors: {
    readonly assigned: number;
    readonly existing: number;
  };
  readonly snapshot: SyncGatewaySnapshot;
  readonly shadow: ShadowDiff;
  readonly observation: Presence<ReadOnlySnapshotObservationResult>;
}

/**
 * Runs an allowed read path for one registered projection.
 *
 * A no-change snapshot does not create an observation occurrence.  Unsafe
 * identity/cell metadata is retained as raw evidence but not converted into a
 * core event; a later writer must quarantine it explicitly.
 */
export async function ingestReadOnlySheetSnapshot(
  options: ReadOnlySheetIngestionOptions,
): Promise<ReadOnlySheetIngestionResult> {
  validateOptions(options);
  const registration = requireRegisteredSyncSheet(options.database, options.physicalSheetId);
  const request = {
    physicalSheetId: registration.physicalSheetId,
    sheetName: registration.tabName,
    registeredRange: registration.registeredRange,
    projection: registration.projection,
    schemaVersion: registration.schemaVersion,
  } as const;
  const ensured = await options.gateway.ensureRowAnchors(request);
  const snapshot = await options.gateway.readSnapshot(request);
  validateSnapshotMatchesRegistration(snapshot, registration);
  const shadow = buildShadowDiff(options.database, registration, snapshot);
  const shouldCapture = shadow.hasChanges || shadow.hasUnsafeIdentity;
  const payloadJson = JSON.stringify({ snapshot, shadow });
  const editorActorId = options.editorActorId ?? absentValue<string>();
  const editorActorSource = options.editorActorSource ?? EDITOR_ACTOR_SOURCES.UNAVAILABLE;
  const observation = shouldCapture
    ? presentValue(persistReadOnlySnapshotObservation(options.database, options.fence, {
        observationId: "observation:" + randomUUID(),
        physicalSheetId: registration.physicalSheetId,
        logicalSheetId: registration.logicalSheetId,
        observationKey: stableHash({
          logicalSheetId: registration.logicalSheetId,
          physicalSheetId: registration.physicalSheetId,
          snapshotHash: snapshot.snapshotHash,
        }),
        payloadJson,
        payloadHash: stableHash(payloadJson),
        source: options.source ?? READ_ONLY_INGESTION_SOURCES.POLLING,
        detectedAt: options.now,
        receivedAt: options.now,
        ingressActorId: options.ingressActorId ?? "typed-sheets-sync-reader",
        editorActorId,
        editorActorSource,
      }))
    : absentValue<ReadOnlySnapshotObservationResult>();
  return {
    registration,
    anchors: { assigned: ensured.assigned, existing: ensured.existing },
    snapshot,
    shadow,
    observation,
  };
}

/**
 * Compares a normalized snapshot with SQLite projection baselines without
 * performing a Sheet write or claiming canonical authority.
 */
export function buildShadowDiff(
  db: DatabaseSyncLike,
  registration: RegisteredSyncSheet,
  snapshot: SyncGatewaySnapshot,
): ShadowDiff {
  validateSnapshotMatchesRegistration(snapshot, registration);
  const bindings = loadBindings(db, registration.physicalSheetId);
  const seenAnchors = new Set<string>();
  const rows: ShadowDiffRow[] = [];
  const duplicateAnchorSet = new Set(snapshot.duplicateAnchors.map((entry) => entry.anchor));

  for (const snapshotRow of snapshot.rows) {
    const anchor = snapshotRow.physicalAnchor;
    if (
      isAbsent(anchor) ||
      (isPresent(anchor) && duplicateAnchorSet.has(anchor.value))
    ) {
      rows.push({
        kind: SHADOW_DIFF_KINDS.UNSAFE_SNAPSHOT,
        physicalAnchor: anchor,
        rowBindingId: absentValue(),
        rowNumber: presentValue(snapshotRow.rowNumber),
        changedFields: [],
        reason: presentValue(
          isAbsent(anchor)
            ? SHADOW_DIFF_REASONS.UNANCHORED_ROW
            : SHADOW_DIFF_REASONS.DUPLICATE_ANCHOR,
        ),
      });
      continue;
    }
    const anchorValue = requirePresent(anchor, "snapshot row anchor");
    seenAnchors.add(anchorValue);
    const binding = lookupResult(bindings.get(anchorValue));
    const invalidMetadata = invalidSnapshotFields(snapshotRow);
    if (invalidMetadata.length > 0) {
      rows.push({
        kind: SHADOW_DIFF_KINDS.UNSAFE_SNAPSHOT,
        physicalAnchor: anchor,
        rowBindingId: binding.kind === LOOKUP_RESULT_KINDS.FOUND
          ? presentValue(binding.value.rowBindingId)
          : absentValue(),
        rowNumber: presentValue(snapshotRow.rowNumber),
        changedFields: invalidMetadata,
        reason: presentValue(SHADOW_DIFF_REASONS.UNSUPPORTED_CELL_METADATA),
      });
      continue;
    }
    if (binding.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      rows.push({
        kind: SHADOW_DIFF_KINDS.UNBOUND,
        physicalAnchor: anchor,
        rowBindingId: absentValue(),
        rowNumber: presentValue(snapshotRow.rowNumber),
        changedFields: Object.keys(snapshotRow.cells).sort(),
        reason: presentValue(SHADOW_DIFF_REASONS.ANCHOR_HAS_NO_ROW_BINDING),
      });
      continue;
    }
    const changedFields = changedFieldsForRow(binding.value, snapshotRow);
    rows.push({
      kind: changedFields.length === EMPTY_ARRAY_LENGTH_ZERO
        ? SHADOW_DIFF_KINDS.UNCHANGED
        : SHADOW_DIFF_KINDS.CHANGED,
      physicalAnchor: anchor,
      rowBindingId: presentValue(binding.value.rowBindingId),
      rowNumber: presentValue(snapshotRow.rowNumber),
      changedFields,
      reason: absentValue(),
    });
  }

  for (const [anchor, binding] of bindings) {
    if (!seenAnchors.has(anchor)) {
      rows.push({
        kind: SHADOW_DIFF_KINDS.MISSING_UNKNOWN,
        physicalAnchor: presentValue(anchor),
        rowBindingId: presentValue(binding.rowBindingId),
        rowNumber: absentValue(),
        changedFields: [],
        reason: presentValue(SHADOW_DIFF_REASONS.POLLING_CANNOT_PROVE_DELETE),
      });
    }
  }

  const hasUnsafeIdentity = rows.some(
    (row) => row.kind === SHADOW_DIFF_KINDS.UNSAFE_SNAPSHOT ||
      row.kind === SHADOW_DIFF_KINDS.MISSING_UNKNOWN,
  );
  return {
    physicalSheetId: registration.physicalSheetId,
    snapshotHash: snapshot.snapshotHash,
    rows,
    hasChanges: rows.some(
      (row) => row.kind === SHADOW_DIFF_KINDS.CHANGED ||
        row.kind === SHADOW_DIFF_KINDS.UNBOUND,
    ),
    hasUnsafeIdentity,
  };
}

interface BindingBaseline {
  readonly rowBindingId: string;
  readonly fieldHashes: ReadonlyMap<string, string>;
}

interface BindingSqlRow {
  readonly anchor_reference: string;
  readonly row_binding_id: string;
  readonly field_name: string | null;
  readonly field_hash: string | null;
}

function loadBindings(db: DatabaseSyncLike, physicalSheetId: string): ReadonlyMap<string, BindingBaseline> {
  const rows = db.prepare(READ_BINDINGS_SQL).all(physicalSheetId) as readonly BindingSqlRow[];
  const result = new Map<string, { rowBindingId: string; fieldHashes: Map<string, string> }>();
  for (const row of rows) {
    const existing = lookupResult(result.get(row.anchor_reference));
    const binding = existing.kind === LOOKUP_RESULT_KINDS.FOUND
      ? existing.value
      : {
          rowBindingId: row.row_binding_id,
          fieldHashes: new Map<string, string>(),
        };
    if (binding.rowBindingId !== row.row_binding_id) {
      throwIngestionError("projection anchor is bound to more than one logical row");
    }
    const fieldName = fromSqlNullable(row.field_name);
    const fieldHash = fromSqlNullable(row.field_hash);
    if (isPresent(fieldName) && isPresent(fieldHash)) {
      binding.fieldHashes.set(fieldName.value, fieldHash.value);
    }
    result.set(row.anchor_reference, binding);
  }
  return result;
}

function changedFieldsForRow(binding: BindingBaseline, row: SyncSnapshotRow): readonly string[] {
  const changed: string[] = [];
  for (const [fieldName, cell] of Object.entries(row.cells)) {
    const knownHash = binding.fieldHashes.get(fieldName);
    if (knownHash === undefined || knownHash !== stableHash(cell.normalizedCell)) changed.push(fieldName);
  }
  return changed.sort();
}

function invalidSnapshotFields(row: SyncSnapshotRow): readonly string[] {
  return Object.entries(row.cells)
    .filter(([, cell]) => !isSupportedSnapshotCell(cell))
    .map(([fieldName]) => fieldName)
    .sort();
}

function isSupportedSnapshotCell(cell: SyncSnapshotCell): boolean {
  return (
    (cell.cellKind === CELL_OBSERVATION_KINDS.BLANK ||
      cell.cellKind === CELL_OBSERVATION_KINDS.LITERAL) &&
    isAbsent(cell.formulaHash) &&
    isAbsent(cell.mergeRange) &&
    isAbsent(cell.errorCode)
  );
}

function validateSnapshotMatchesRegistration(
  snapshot: SyncGatewaySnapshot,
  registration: RegisteredSyncSheet,
): void {
  if (
    snapshot.sheetName !== registration.tabName ||
    snapshot.registeredRange !== registration.registeredRange ||
    snapshot.projection !== registration.projection ||
    snapshot.schemaVersion !== registration.schemaVersion
  ) {
    throwIngestionError("gateway snapshot does not match the SQLite registry allowlist");
  }
  if (new Set(snapshot.headers).size !== snapshot.headers.length) {
    throwIngestionError("gateway snapshot has duplicate headers");
  }
}

function validateOptions(options: ReadOnlySheetIngestionOptions): void {
  if (options.physicalSheetId.length === EMPTY_STRING_LENGTH_ZERO) {
    throwIngestionError("physical sheet ID is required");
  }
  if (
    !Number.isSafeInteger(options.now) ||
    options.now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwIngestionError("read-only ingestion time must be a non-negative safe integer");
  }
  const editorActorId = options.editorActorId ?? absentValue<string>();
  const editorActorSource = options.editorActorSource ?? EDITOR_ACTOR_SOURCES.UNAVAILABLE;
  if (
    editorActorSource === EDITOR_ACTOR_SOURCES.GOOGLE_ACTIVE_USER &&
    (!isPresent(editorActorId) || editorActorId.value.length === EMPTY_STRING_LENGTH_ZERO)
  ) {
    throwIngestionError("verified editor source requires an editor actor ID");
  }
  if (
    editorActorSource === EDITOR_ACTOR_SOURCES.UNAVAILABLE &&
    isPresent(editorActorId)
  ) {
    throwIngestionError("unavailable editor source cannot include an editor actor ID");
  }
}

type PresentValue<T> = {
  readonly kind: typeof PRESENCE_KINDS.PRESENT;
  readonly value: T;
};

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function isPresent<T>(value: Presence<T>): value is PresentValue<T> {
  return value.kind === PRESENCE_KINDS.PRESENT;
}

function isAbsent<T>(value: Presence<T>): boolean {
  return value.kind === PRESENCE_KINDS.ABSENT;
}

function requirePresent<T>(value: Presence<T>, label: string): T {
  if (!isPresent(value)) throwIngestionError(`${label} is required`);
  return value.value;
}

function lookupResult<T>(value: T | undefined): LookupResult<T> {
  return value === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value };
}

function throwIngestionError(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION, message);
}
