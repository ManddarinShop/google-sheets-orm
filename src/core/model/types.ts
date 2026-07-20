/**
 * Pure domain model types shared across the core evaluator.
 *
 * These types contain no Google SDK, SQLite, or platform-specific values.
 * All cell values are NormalizedCell, all timestamps are audit-only ISO strings.
 */

import type { NormalizedCell } from "../encoding/types.js";
import type { ConflictStatus } from "./constants.js";

export type { ConflictStatus } from "./constants.js";

// ---------------------------------------------------------------------------
// Entity state (canonical)
// ---------------------------------------------------------------------------

/** A single field within a canonical entity. */
export interface CanonicalFieldState {
  readonly fieldName: string;
  readonly value: NormalizedCell;
  readonly fieldRevision: number;
  readonly ownership: FieldOwnership;
}

/** Ownership of a field, determining whether user edits are accepted. */
export type FieldOwnership = "user" | "system";

/** The canonical accepted state of an entity as seen by the evaluator. */
export interface CanonicalEntityState {
  readonly entityId: string;
  readonly entityRevision: number;
  readonly businessKey: string;
  readonly fields: ReadonlyMap<string, CanonicalFieldState>;
}

// ---------------------------------------------------------------------------
// Projection types
// ---------------------------------------------------------------------------

export type Projection = "user_input" | "system_state" | "legacy_combined";

export type RowBindingState =
  | "candidate"
  | "active"
  | "tombstoned"
  | "ambiguous";

// ---------------------------------------------------------------------------
// Normalized row
// ---------------------------------------------------------------------------

/** A single field in an observed row change. */
export interface NormalizedRowField {
  readonly fieldName: string;
  readonly cell: NormalizedCell;
  readonly baseFieldRevision: number | null;
}

/** A row read from a Sheet snapshot, identified by row binding. */
export interface NormalizedRow {
  readonly rowBindingId: string;
  readonly fields: ReadonlyMap<string, NormalizedRowField>;
}

// ---------------------------------------------------------------------------
// Observation types
// ---------------------------------------------------------------------------

export type ObservationSource = "onEdit" | "polling" | "resolution" | "repair";

export type RowOperation = "insert" | "update" | "delete" | "rename";

/** Evidence supplied by the anchor provider when an observed row disappeared. */
export type DeleteEvidence = "deleted_confirmed" | "anchor_lost" | "unavailable";

/** Provenance of an optional editor identity retained for audit only. */
export type EditorActorSource = "google_active_user" | "unavailable";

/** A single field change within a row. */
export interface ObservedFieldChange {
  readonly fieldName: string;
  readonly previousValue: NormalizedCell;
  readonly nextValue: NormalizedCell;
  readonly baseFieldRevision: number | null;
}

/** A single row change within a batch. */
export interface ObservedRowChange {
  readonly rowBindingId: string;
  readonly operation: RowOperation;
  readonly beforeRow: NormalizedRow | null;
  readonly afterRow: NormalizedRow | null;
  readonly baseVisibleRevision: number;
  readonly baseEntityRevision: number | null;
  /** Required for delete; anchor loss is never treated as a tombstone. */
  readonly deleteEvidence: DeleteEvidence | null;
  readonly fields: readonly ObservedFieldChange[];
}

/** A batch of row changes observed from one paste/drag-fill/poll cycle. */
export interface ObservedEditBatch {
  readonly batchId: string;
  readonly source: ObservationSource;
  readonly sheetId: string;
  readonly projection: Projection;
  /** Schema version reported by the normalized snapshot. */
  readonly schemaVersion: number;
  readonly atomicity: "row_independent";
  readonly baseSnapshotHash: string;
  /** Authenticated service principal; audit metadata, never a merge input. */
  readonly ingressActorId: string;
  /** Verified editor identity when the gateway can provide one. */
  readonly editorActorId: string | null;
  readonly editorActorSource: EditorActorSource;
  readonly rows: readonly ObservedRowChange[];
}

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

/** A normalized Sheet change event after identity resolution. */
export interface SheetChangeEvent {
  readonly eventId: string;
  readonly eventKey: string;
  readonly payloadHash: string;
  readonly batchId: string;
  readonly source: ObservationSource;
  readonly sheetId: string;
  readonly projection: Projection;
  readonly rowBindingId: string;
  readonly operation: RowOperation;
  readonly baseVisibleRevision: number;
  readonly baseSnapshotHash: string;
  readonly baseEntityRevision: number | null;
  readonly fields: readonly ObservedFieldChange[];
  readonly beforeRowHash: string;
  readonly afterRowHash: string;
}

// ---------------------------------------------------------------------------
// Conflict model
// ---------------------------------------------------------------------------

/** Field-level conflict record preserving both candidate and canonical state. */
export interface SyncConflict {
  readonly conflictId: string;
  readonly conflictGroupId: string | null;
  readonly eventId: string;
  readonly rowBindingId: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly userValue: NormalizedCell;
  readonly userBaseRevision: number;
  readonly canonicalValueAtDetection: NormalizedCell;
  readonly canonicalRevisionAtDetection: number;
  readonly currentCanonicalValue: NormalizedCell;
  readonly currentCanonicalRevision: number;
  /** Monotonic attempt generation for this field's active candidate. */
  readonly candidateEpoch: number;
  readonly status: ConflictStatus;
  readonly resolutionCommandId: string | null;
}

// ---------------------------------------------------------------------------
// Quarantine model
// ---------------------------------------------------------------------------

export type QuarantineReason =
  | "unknown_field"
  | "unknown_base_revision"
  | "ambiguous_identity"
  | "identity_tampering"
  | "schema_drift"
  | "system_field_edit"
  | "mixed_ownership_edit"
  | "invalid_cell"
  | "formula_unsupported"
  | "merged_cell_unsupported"
  | "cell_error"
  | "anchor_lost"
  | "invalid_snapshot_metadata"
  | "invalid_event";

/** A plan to quarantine a row with preserved evidence. */
export interface QuarantinePlan {
  readonly quarantineId: string;
  readonly reason: QuarantineReason;
  readonly rowBindingId: string;
  readonly beforeRow: NormalizedRow | null;
  readonly afterRow: NormalizedRow | null;
  readonly fields: readonly ObservedFieldChange[];
  readonly repairFields: readonly string[];
}

// ---------------------------------------------------------------------------
// Repair model
// ---------------------------------------------------------------------------

/** A plan to repair system-owned fields to canonical values. */
export interface RepairPlan {
  readonly quarantineId: string;
  readonly rowBindingId: string;
  readonly affectedSystemFields: readonly string[];
  readonly canonicalTargetValues: ReadonlyMap<string, NormalizedCell>;
  readonly repairGuardHash: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Ownership manifest
// ---------------------------------------------------------------------------

/** Ownership metadata for a single field. */
export interface FieldManifestEntry {
  readonly fieldName: string;
  readonly ownership: FieldOwnership;
  readonly projection: Projection;
  readonly type: "string" | "number" | "boolean" | "date";
  readonly required: boolean;
  readonly unique: boolean;
}

/** Maps field names to ownership metadata. */
export type OwnershipManifest = ReadonlyMap<string, FieldManifestEntry>;

// ---------------------------------------------------------------------------
// Row binding context (provided by storage layer)
// ---------------------------------------------------------------------------

/** Identity context for a row binding, provided to the evaluator. */
export interface RowBindingContext {
  readonly rowBindingId: string;
  readonly entityId: string | null;
  readonly bindingState: RowBindingState;
  readonly businessKey: string | null;
  readonly candidateEpoch: number;
}

// ---------------------------------------------------------------------------
// Resolution command
// ---------------------------------------------------------------------------

export type ResolutionAction = "acknowledge_system";

export type ActorRole = "sheet_editor" | "sync_operator" | "sync_admin";

/** A trusted resolution command for a conflict. */
export interface ResolutionCommand {
  readonly commandId: string;
  readonly requestKey: string;
  readonly action: ResolutionAction;
  readonly actorId: string;
  readonly role: ActorRole;
  readonly targetConflictId: string;
  readonly expectedRevision: number;
  readonly activeCandidateHash: string;
  /** Prevents an old acknowledgement from resolving an ABA candidate retry. */
  readonly expectedCandidateEpoch: number;
  readonly payloadHash: string;
}

// ---------------------------------------------------------------------------
// Effect model
// ---------------------------------------------------------------------------

export type EffectKind =
  | "system_projection"
  | "candidate_reconcile"
  | "system_repair"
  | "resolution_projection"
  /** Removes a resolved system-owned Sync_Conflicts row after a visible CAS. */
  | "resolution_delete";

export type EffectTargetKind = "entity" | "row_binding" | "projection_row" | "conflict";

export type EffectStatus =
  | "pending"
  | "processing"
  | "applied"
  | "blocked_candidate"
  | "superseded"
  | "conflict"
  | "failed";

/** A sheet effect to be dispatched by the outbox worker. */
export interface SheetEffect {
  readonly effectId: string;
  readonly effectKind: EffectKind;
  readonly commitId: string;
  readonly sheetId: string;
  readonly projection: Projection;
  readonly rowBindingId: string;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly targetEntityRevision: number;
  readonly targetFieldRevisionHash: string;
  readonly targetCanonicalCommitId: string;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: string | null;
  readonly sourceQuarantineId: string | null;
  readonly payloadHash: string;
  readonly effectDedupeKey: string;
  readonly streamSequence: number;
}
