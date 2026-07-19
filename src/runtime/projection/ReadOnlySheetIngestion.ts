/**
 * Registry-bound, no-projection-write Sheet observation runtime.
 *
 * It ensures metadata anchors, reads a normalized snapshot, compares it with
 * SQLite's confirmed visible baseline, and appends only raw observation
 * evidence.  It deliberately does not call applyEffects(), evaluate a winner,
 * or infer a delete from a missing polling row.
 */

import { randomUUID } from "node:crypto";
import { stableHash } from "../../core/index.js";
import {
  persistReadOnlySnapshotObservation,
  requireRegisteredSyncSheet,
  type DatabaseSyncLike,
  type FencingContext,
  type ReadOnlySnapshotObservationResult,
  type RegisteredSyncSheet,
} from "../../storage/index.js";
import type {
  SyncGatewaySnapshot,
  SyncSnapshotCell,
  SyncSnapshotRow,
  SyncSheetGateway,
} from "../gateway/syncGateway.js";

/** Diff classification that never turns a missing anchor into an automatic delete. */
export type ShadowDiffKind =
  | "unchanged"
  | "changed"
  | "unbound"
  | "missing_unknown"
  | "unsafe_snapshot";

/** One row-level observation candidate visible to the next evaluation phase. */
export interface ShadowDiffRow {
  readonly kind: ShadowDiffKind;
  readonly physicalAnchor: string | null;
  readonly rowBindingId: string | null;
  readonly rowNumber: number | null;
  readonly changedFields: readonly string[];
  readonly reason: string | null;
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
  readonly source?: "polling" | "onEdit";
  readonly ingressActorId?: string;
  readonly editorActorId?: string | null;
  readonly editorActorSource?: "google_active_user" | "unavailable";
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
  readonly observation: ReadOnlySnapshotObservationResult | null;
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
  const observation = shouldCapture
    ? persistReadOnlySnapshotObservation(options.database, options.fence, {
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
      source: options.source ?? "polling",
      detectedAt: options.now,
      receivedAt: options.now,
      ingressActorId: options.ingressActorId ?? "typed-sheets-sync-reader",
      editorActorId: options.editorActorId ?? null,
      editorActorSource: options.editorActorSource ?? "unavailable",
    })
    : null;
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
    if (anchor === null || duplicateAnchorSet.has(anchor)) {
      rows.push({
        kind: "unsafe_snapshot",
        physicalAnchor: anchor,
        rowBindingId: null,
        rowNumber: snapshotRow.rowNumber,
        changedFields: [],
        reason: anchor === null ? "unanchored_row" : "duplicate_anchor",
      });
      continue;
    }
    seenAnchors.add(anchor);
    const binding = bindings.get(anchor);
    const invalidMetadata = invalidSnapshotFields(snapshotRow);
    if (invalidMetadata.length > 0) {
      rows.push({
        kind: "unsafe_snapshot",
        physicalAnchor: anchor,
        rowBindingId: binding?.rowBindingId ?? null,
        rowNumber: snapshotRow.rowNumber,
        changedFields: invalidMetadata,
        reason: "unsupported_cell_metadata",
      });
      continue;
    }
    if (binding === undefined) {
      rows.push({
        kind: "unbound",
        physicalAnchor: anchor,
        rowBindingId: null,
        rowNumber: snapshotRow.rowNumber,
        changedFields: Object.keys(snapshotRow.cells).sort(),
        reason: "anchor_has_no_row_binding",
      });
      continue;
    }
    const changedFields = changedFieldsForRow(binding, snapshotRow);
    rows.push({
      kind: changedFields.length === 0 ? "unchanged" : "changed",
      physicalAnchor: anchor,
      rowBindingId: binding.rowBindingId,
      rowNumber: snapshotRow.rowNumber,
      changedFields,
      reason: null,
    });
  }

  for (const [anchor, binding] of bindings) {
    if (!seenAnchors.has(anchor)) {
      rows.push({
        kind: "missing_unknown",
        physicalAnchor: anchor,
        rowBindingId: binding.rowBindingId,
        rowNumber: null,
        changedFields: [],
        reason: "polling_cannot_prove_delete",
      });
    }
  }

  const hasUnsafeIdentity = rows.some((row) => row.kind === "unsafe_snapshot" || row.kind === "missing_unknown");
  return {
    physicalSheetId: registration.physicalSheetId,
    snapshotHash: snapshot.snapshotHash,
    rows,
    hasChanges: rows.some((row) => row.kind === "changed" || row.kind === "unbound"),
    hasUnsafeIdentity,
  };
}

interface BindingBaseline {
  readonly rowBindingId: string;
  readonly fieldHashes: ReadonlyMap<string, string>;
}

function loadBindings(db: DatabaseSyncLike, physicalSheetId: string): ReadonlyMap<string, BindingBaseline> {
  const rows = db.prepare(`
    SELECT projection.anchor_reference, projection.row_binding_id,
           field.field_name, COALESCE(field.last_observed_field_hash, field.confirmed_field_hash) AS field_hash
    FROM projection_row_binding AS projection
    LEFT JOIN sheet_visible_field_state AS field
      ON field.physical_sheet_id = projection.physical_sheet_id
      AND field.row_binding_id = projection.row_binding_id
    WHERE projection.physical_sheet_id = ? AND projection.row_binding_id IS NOT NULL
    ORDER BY projection.anchor_reference, field.field_name
  `).all(physicalSheetId) as readonly {
    readonly anchor_reference: string;
    readonly row_binding_id: string;
    readonly field_name: string | null;
    readonly field_hash: string | null;
  }[];
  const result = new Map<string, { rowBindingId: string; fieldHashes: Map<string, string> }>();
  for (const row of rows) {
    const existing = result.get(row.anchor_reference) ?? {
      rowBindingId: row.row_binding_id,
      fieldHashes: new Map<string, string>(),
    };
    if (existing.rowBindingId !== row.row_binding_id) {
      throw new Error("projection anchor is bound to more than one logical row");
    }
    if (row.field_name !== null && row.field_hash !== null) {
      existing.fieldHashes.set(row.field_name, row.field_hash);
    }
    result.set(row.anchor_reference, existing);
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
  return (cell.cellKind === "blank" || cell.cellKind === "literal") &&
    cell.formulaHash === null && cell.mergeRange === null && cell.errorCode === null;
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
    throw new Error("gateway snapshot does not match the SQLite registry allowlist");
  }
  if (new Set(snapshot.headers).size !== snapshot.headers.length) {
    throw new Error("gateway snapshot has duplicate headers");
  }
}

function validateOptions(options: ReadOnlySheetIngestionOptions): void {
  if (options.physicalSheetId.length === 0) throw new Error("physical sheet ID is required");
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new Error("read-only ingestion time must be a non-negative safe integer");
  }
  if (options.editorActorSource === "google_active_user" &&
    (typeof options.editorActorId !== "string" || options.editorActorId.length === 0)) {
    throw new Error("verified editor source requires an editor actor ID");
  }
  if (options.editorActorSource === "unavailable" && options.editorActorId !== undefined && options.editorActorId !== null) {
    throw new Error("unavailable editor source cannot include an editor actor ID");
  }
}
