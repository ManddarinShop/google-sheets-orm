/**
 * Fenced canonical field commits for the SQLite-authoritative prototype.
 *
 * The writer applies every accepted field CAS and any resulting outbox rows in
 * one SQLite savepoint. A stale field or lost fence rolls back the complete
 * row-level commit, so a partially accepted event cannot leak a partial state.
 */

import type { FieldOwnership, NormalizedCell } from "../../core/index.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { isFencingValid } from "../sync/writerLease.js";
import type { FencingContext } from "../sync/writerLease.js";
import type { NewEffect } from "../sync/effectOutbox.js";

/** A field value the writer should insert or compare-and-set. */
export interface CanonicalFieldWrite {
  readonly fieldName: string;
  readonly value: NormalizedCell;
  /** `null` is required for inserts; updates require the current revision. */
  readonly expectedFieldRevision: number | null;
  readonly ownership: FieldOwnership;
}

/** Shared canonical commit fields used by every row operation. */
interface CanonicalCommitBase {
  readonly entityId: string;
  readonly acceptedSnapshotHash: string | null;
  /** Effects are inserted in this same savepoint as the canonical mutation. */
  readonly effects: readonly NewEffect[];
}

/** An insert prepared from one core evaluation result. */
export interface CanonicalInsertCommitInput extends CanonicalCommitBase {
  readonly kind: "insert";
  readonly fields: readonly CanonicalFieldWrite[];
}

/** A field-level update prepared from one core evaluation result. */
export interface CanonicalUpdateCommitInput extends CanonicalCommitBase {
  readonly kind: "update";
  readonly fields: readonly CanonicalFieldWrite[];
}

/** An insert or field-level update prepared from one core evaluation result. */
export type CanonicalFieldCommitInput = CanonicalInsertCommitInput | CanonicalUpdateCommitInput;

/** A confirmed delete that turns an active canonical entity into a tombstone. */
export interface CanonicalDeleteCommitInput extends CanonicalCommitBase {
  readonly kind: "delete";
  /** Entity revision observed with the explicit delete evidence. */
  readonly expectedEntityRevision: number;
}

/** A row-level canonical mutation prepared from one core evaluation result. */
export type CanonicalCommitInput = CanonicalFieldCommitInput | CanonicalDeleteCommitInput;

/** Observable result of a fenced canonical commit attempt. */
export type CanonicalCommitResult =
  | {
      readonly kind: "applied";
      readonly entityRevision: number;
      readonly fieldRevisions: ReadonlyMap<string, number>;
    }
  | { readonly kind: "stale"; readonly target: "entity" | "field"; readonly fieldName: string | null }
  | { readonly kind: "fenced_out" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Commits an insert, field-level update, or confirmed delete under a writer fence.
 *
 * Field revisions are independent: an update CASes each supplied field, then
 * increments the entity revision once. An outbox uniqueness failure therefore
 * rolls back the canonical state as well as the pending effect rows.
 */
export function commitCanonicalChanges(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: CanonicalCommitInput,
): CanonicalCommitResult {
  const invalidReason = validateInput(input);
  if (invalidReason !== null) return { kind: "invalid", reason: invalidReason };
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };

  db.exec("SAVEPOINT canonical_commit");
  try {
    const result = input.kind === "insert"
      ? applyInsert(db, fence, input)
      : input.kind === "update"
        ? applyUpdate(db, fence, input)
        : applyDelete(db, fence, input);
    if (result.kind !== "applied") {
      rollbackSavepoint(db, "canonical_commit");
      return result;
    }

    for (const effect of input.effects) {
      insertPendingEffect(db, fence, effect);
    }

    db.exec("RELEASE canonical_commit");
    return result;
  } catch (error: unknown) {
    rollbackSavepoint(db, "canonical_commit");
    if (error instanceof FenceLostError) return { kind: "fenced_out" };
    throw error;
  }
}

function applyInsert(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: CanonicalInsertCommitInput,
): CanonicalCommitResult {
  const entityResult = db.prepare(`
    INSERT INTO entity_state (entity_id, entity_revision, accepted_snapshot_hash, status)
    SELECT ?, 1, ?, 'active'
    WHERE EXISTS (${fenceExistsSql()})
  `).run(
    input.entityId,
    input.acceptedSnapshotHash,
    ...fenceParameters(fence),
  );
  if (entityResult.changes !== 1) return lostFenceOrStaleEntity(db, fence);

  const fieldRevisions = new Map<string, number>();
  for (const field of input.fields) {
    const result = db.prepare(`
      INSERT INTO entity_field_state (
        entity_id, field_name, normalized_value, field_revision, ownership
      )
      SELECT ?, ?, ?, 1, ?
      WHERE EXISTS (${fenceExistsSql()})
    `).run(
      input.entityId,
      field.fieldName,
      serializeCell(field.value),
      field.ownership,
      ...fenceParameters(fence),
    );
    if (result.changes !== 1) throwFenceIfLost(db, fence);
    if (result.changes !== 1) return { kind: "stale", target: "field", fieldName: field.fieldName };
    fieldRevisions.set(field.fieldName, 1);
  }

  return { kind: "applied", entityRevision: 1, fieldRevisions };
}

function applyUpdate(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: CanonicalUpdateCommitInput,
): CanonicalCommitResult {
  const entity = db.prepare(`
    SELECT entity_revision FROM entity_state
    WHERE entity_id = ? AND status = 'active'
  `).get(input.entityId) as { entity_revision: number } | undefined;
  if (entity === undefined) return { kind: "stale", target: "entity", fieldName: null };

  const fieldRevisions = new Map<string, number>();
  for (const field of input.fields) {
    const result = db.prepare(`
      UPDATE entity_field_state
      SET normalized_value = ?, field_revision = field_revision + 1
      WHERE entity_id = ? AND field_name = ? AND field_revision = ? AND ownership = ?
        AND EXISTS (${fenceExistsSql()})
    `).run(
      serializeCell(field.value),
      input.entityId,
      field.fieldName,
      field.expectedFieldRevision,
      field.ownership,
      ...fenceParameters(fence),
    );
    if (result.changes !== 1) {
      throwFenceIfLost(db, fence);
      return { kind: "stale", target: "field", fieldName: field.fieldName };
    }
    fieldRevisions.set(field.fieldName, field.expectedFieldRevision! + 1);
  }

  const nextEntityRevision = entity.entity_revision + 1;
  const entityResult = db.prepare(`
    UPDATE entity_state
    SET entity_revision = ?, accepted_snapshot_hash = ?
    WHERE entity_id = ? AND entity_revision = ? AND status = 'active'
      AND EXISTS (${fenceExistsSql()})
  `).run(
    nextEntityRevision,
    input.acceptedSnapshotHash,
    input.entityId,
    entity.entity_revision,
    ...fenceParameters(fence),
  );
  if (entityResult.changes !== 1) return lostFenceOrStaleEntity(db, fence);

  return { kind: "applied", entityRevision: nextEntityRevision, fieldRevisions };
}

/** Marks an entity tombstoned only when the observed entity revision is still current. */
function applyDelete(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: CanonicalDeleteCommitInput,
): CanonicalCommitResult {
  const nextEntityRevision = input.expectedEntityRevision + 1;
  const result = db.prepare(`
    UPDATE entity_state
    SET entity_revision = ?, accepted_snapshot_hash = ?, status = 'tombstoned'
    WHERE entity_id = ? AND entity_revision = ? AND status = 'active'
      AND EXISTS (${fenceExistsSql()})
  `).run(
    nextEntityRevision,
    input.acceptedSnapshotHash,
    input.entityId,
    input.expectedEntityRevision,
    ...fenceParameters(fence),
  );
  if (result.changes !== 1) return lostFenceOrStaleEntity(db, fence);

  return {
    kind: "applied",
    entityRevision: nextEntityRevision,
    fieldRevisions: new Map(),
  };
}

function insertPendingEffect(
  db: DatabaseSyncLike,
  fence: FencingContext,
  effect: NewEffect,
): void {
  const result = db.prepare(`
    INSERT INTO sheet_effect_outbox (
      effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
      projection, row_binding_id, conflict_id, target_kind, target_id,
      target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
      expected_visible_revision, expected_visible_hash, repair_guard_hash,
      source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
      stream_sequence, created_at, status
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
    WHERE EXISTS (${fenceExistsSql()})
  `).run(
    effect.effectId,
    effect.effectKind,
    effect.commitId,
    effect.logicalSheetId,
    effect.physicalSheetId,
    effect.projection,
    effect.rowBindingId,
    effect.conflictId,
    effect.targetKind,
    effect.targetId,
    effect.targetEntityRevision,
    effect.targetFieldRevisionHash,
    effect.targetCanonicalCommitId,
    effect.expectedVisibleRevision,
    effect.expectedVisibleHash,
    effect.repairGuardHash,
    effect.sourceQuarantineId,
    effect.payloadJson,
    effect.payloadHash,
    effect.effectDedupeKey,
    effect.streamSequence,
    fence.now,
    ...fenceParameters(fence),
  );
  if (result.changes !== 1) throwFenceIfLost(db, fence);
  if (result.changes !== 1) {
    throw new Error(`could not insert effect ${effect.effectId}`);
  }
}

function validateInput(input: CanonicalCommitInput): string | null {
  if (input.entityId.length === 0) return "entity ID is required";
  if (input.kind === "delete") {
    return Number.isSafeInteger(input.expectedEntityRevision) && input.expectedEntityRevision >= 1
      ? null
      : "delete must have a positive expected entity revision";
  }
  if (input.fields.length === 0) return "at least one accepted field is required";

  const fieldNames = new Set<string>();
  for (const field of input.fields) {
    if (field.fieldName.length === 0 || fieldNames.has(field.fieldName)) {
      return "field names must be non-empty and unique";
    }
    fieldNames.add(field.fieldName);

    if (input.kind === "insert" && field.expectedFieldRevision !== null) {
      return "insert fields must have a null expected revision";
    }
    if (
      input.kind === "update" &&
      (field.expectedFieldRevision === null ||
        !Number.isSafeInteger(field.expectedFieldRevision) ||
        field.expectedFieldRevision < 1)
    ) {
      return "update fields must have a positive expected revision";
    }
  }
  return null;
}

function fenceExistsSql(): string {
  return `
    SELECT 1 FROM writer_lease
    WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?
  `;
}

function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

function serializeCell(value: NormalizedCell): string {
  return JSON.stringify(value);
}

function lostFenceOrStaleEntity(
  db: DatabaseSyncLike,
  fence: FencingContext,
): CanonicalCommitResult {
  return isFencingValid(db, fence)
    ? { kind: "stale", target: "entity", fieldName: null }
    : { kind: "fenced_out" };
}

function throwFenceIfLost(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) throw new FenceLostError();
}

function rollbackSavepoint(db: DatabaseSyncLike, name: string): void {
  db.exec(`ROLLBACK TO ${name}`);
  db.exec(`RELEASE ${name}`);
}

class FenceLostError extends Error {}
