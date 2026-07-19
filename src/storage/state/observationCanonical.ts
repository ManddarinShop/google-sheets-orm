/**
 * Canonical-state and conflict-ledger mutations for one observed row.
 *
 * Every exported operation assumes its caller already holds the writer fence
 * and is inside the observation writer's immediate transaction.
 */

import { stableHash, type ObservedRowChange, type RowEvaluationResult } from "../../core/index.js";
import { commitCanonicalChanges, type CanonicalCommitInput } from "./canonicalCommit.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import type { FencingContext } from "../sync/writerLease.js";
import { auditJson } from "./observationAudit.js";
import { candidateHash, readActiveCandidate } from "./observationLedger.js";
import type {
  AppliedCanonicalCommit,
  CanonicalRowMutation,
  PersistObservedRowInput,
  RowBindingRow,
} from "./observationTypes.js";
import { CanonicalStaleError, FenceLostError } from "./observationTypes.js";

/**
 * Applies a validated canonical change, then updates bindings, key ownership,
 * and any unresolved conflicts rebased by that change.
 */
export function applyCanonicalMutation(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  binding: RowBindingRow,
): AppliedCanonicalCommit | null {
  const needsCanonical = input.evaluation.acceptedFields.length > 0 ||
    (row.operation === "delete" && input.evaluation.outcome === "accepted");
  if (!needsCanonical) return null;

  const mutation = input.canonical;
  if (mutation === null) throw new Error("canonical mutation disappeared after validation");
  assertCanonicalBinding(binding, mutation.commit);
  const result = commitCanonicalChanges(db, fence, mutation.commit);
  if (result.kind === "fenced_out") throw new FenceLostError();
  if (result.kind === "stale") throw new CanonicalStaleError();
  if (result.kind === "invalid") {
    throw new Error(`canonical mutation was invalid: ${result.reason}`);
  }

  transitionBindingAfterCanonicalCommit(db, input.batch.sheetId, row.rowBindingId, mutation.commit);
  applyBusinessKeyChanges(db, input.batch.sheetId, mutation);
  rebaseActiveConflicts(db, input, row, mutation, result);
  return result;
}

/** Writes new field candidates unless an equivalent unresolved candidate is active. */
export function persistConflictAttempts(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  binding: RowBindingRow,
  eventId: string,
): readonly string[] {
  if (input.evaluation.conflicts.length === 0) return [];
  if (binding.state !== "active" || binding.entity_id === null) {
    throw new Error("a conflict requires an active entity binding");
  }

  const conflictIds: string[] = [];
  const conflictGroupId = input.evaluation.conflicts.length > 1 ? `conflict-group:${eventId}` : null;
  for (const conflict of input.evaluation.conflicts) {
    const active = readActiveCandidate(
      db,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      conflict.fieldName,
    );
    const hash = candidateHash(conflict);
    if (
      active !== null &&
      (active.status === "OPEN" || active.status === "NEEDS_REBASE") &&
      active.active_candidate_hash === hash
    ) {
      continue;
    }

    const previousEpoch = Math.max(
      active?.candidate_epoch ?? 0,
      maxCandidateEpoch(db, row.rowBindingId, conflict.fieldName),
    );
    const candidateEpoch = previousEpoch + 1;
    const conflictId = `conflict:${stableHash({
      eventId,
      rowBindingId: row.rowBindingId,
      fieldName: conflict.fieldName,
      candidateEpoch,
    })}`;
    db.prepare(`
      INSERT INTO sync_conflict (
        conflict_id, conflict_group_id, event_id, logical_sheet_id, entity_id, row_binding_id,
        field_name, user_value, user_base_revision, canonical_value_at_detection,
        canonical_revision_at_detection, current_canonical_value, current_canonical_revision,
        candidate_epoch, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `).run(
      conflictId,
      conflictGroupId,
      eventId,
      input.batch.sheetId,
      binding.entity_id,
      row.rowBindingId,
      conflict.fieldName,
      auditJson(conflict.userValue),
      conflict.userBaseRevision,
      auditJson(conflict.canonicalValue),
      conflict.canonicalRevision,
      auditJson(conflict.canonicalValue),
      conflict.canonicalRevision,
      candidateEpoch,
      input.observation.receivedAt,
      input.observation.receivedAt,
    );
    db.prepare(`
      INSERT INTO sheet_visible_field_state (
        physical_sheet_id, projection, row_binding_id, field_name,
        confirmed_field_hash, confirmed_visible_revision,
        active_candidate_conflict_id, active_candidate_hash, candidate_epoch,
        last_observed_field_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
      DO UPDATE SET
        active_candidate_conflict_id = excluded.active_candidate_conflict_id,
        active_candidate_hash = excluded.active_candidate_hash,
        candidate_epoch = excluded.candidate_epoch,
        last_observed_field_hash = excluded.last_observed_field_hash
    `).run(
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      conflict.fieldName,
      stableHash(conflict.canonicalValue),
      row.baseVisibleRevision,
      conflictId,
      hash,
      candidateEpoch,
      stableHash(conflict.userValue),
    );
    db.prepare(`
      UPDATE row_binding
      SET candidate_epoch = CASE
        WHEN candidate_epoch < ? THEN ?
        ELSE candidate_epoch
      END
      WHERE row_binding_id = ? AND logical_sheet_id = ?
    `).run(candidateEpoch, candidateEpoch, row.rowBindingId, input.batch.sheetId);
    conflictIds.push(conflictId);
  }
  return conflictIds;
}

/** Rejects an impossible persistence result before it becomes public output. */
export function requirePersistedOutcome(
  evaluation: RowEvaluationResult,
): "accepted" | "partially_accepted" | "conflict" {
  if (evaluation.outcome === "quarantine") {
    throw new Error("a quarantined row cannot be reported as a persisted event outcome");
  }
  return evaluation.outcome;
}

function assertCanonicalBinding(binding: RowBindingRow, commit: CanonicalCommitInput): void {
  if (commit.kind === "insert") {
    if (binding.state !== "candidate" || binding.entity_id !== null) {
      throw new CanonicalStaleError();
    }
    return;
  }
  if (binding.state !== "active" || binding.entity_id !== commit.entityId) {
    throw new CanonicalStaleError();
  }
}

function transitionBindingAfterCanonicalCommit(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  rowBindingId: string,
  commit: CanonicalCommitInput,
): void {
  if (commit.kind === "update") return;
  const result = commit.kind === "insert"
    ? db.prepare(`
      UPDATE row_binding
      SET entity_id = ?, state = 'active'
      WHERE row_binding_id = ? AND logical_sheet_id = ?
        AND state = 'candidate' AND entity_id IS NULL
    `).run(commit.entityId, rowBindingId, logicalSheetId)
    : db.prepare(`
      UPDATE row_binding
      SET state = 'tombstoned'
      WHERE row_binding_id = ? AND logical_sheet_id = ?
        AND state = 'active' AND entity_id = ?
    `).run(rowBindingId, logicalSheetId, commit.entityId);
  if (result.changes !== 1) throw new CanonicalStaleError();
}

function applyBusinessKeyChanges(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  mutation: CanonicalRowMutation,
): void {
  const commit = mutation.commit;
  if (commit.kind === "delete") {
    db.prepare(`
      UPDATE business_key_index
      SET state = 'inactive'
      WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
    `).run(logicalSheetId, commit.entityId);
    return;
  }

  for (const change of mutation.businessKeyChanges) {
    if (
      change.previousNormalizedKey !== null &&
      change.previousNormalizedKey !== change.nextNormalizedKey
    ) {
      const retired = db.prepare(`
        UPDATE business_key_index
        SET state = 'inactive'
        WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ?
          AND entity_id = ? AND state = 'active'
      `).run(
        logicalSheetId,
        change.fieldName,
        change.previousNormalizedKey,
        commit.entityId,
      );
      if (retired.changes !== 1) throw new CanonicalStaleError();
    }

    if (change.nextNormalizedKey !== null) {
      ensureActiveBusinessKey(
        db,
        logicalSheetId,
        change.fieldName,
        change.nextNormalizedKey,
        commit.entityId,
      );
    }
  }
}

function ensureActiveBusinessKey(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  fieldName: string,
  normalizedKey: string,
  entityId: string,
): void {
  const existing = db.prepare(`
    SELECT entity_id
    FROM business_key_index
    WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ? AND state = 'active'
  `).get(logicalSheetId, fieldName, normalizedKey) as { entity_id: string } | undefined;
  if (existing !== undefined) {
    if (existing.entity_id !== entityId) throw new CanonicalStaleError();
    return;
  }
  db.prepare(`
    INSERT INTO business_key_index (
      logical_sheet_id, field_name, normalized_key, entity_id, state
    ) VALUES (?, ?, ?, ?, 'active')
  `).run(logicalSheetId, fieldName, normalizedKey, entityId);
}

function rebaseActiveConflicts(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  mutation: CanonicalRowMutation,
  result: AppliedCanonicalCommit,
): void {
  if (mutation.commit.kind === "delete") return;
  for (const field of mutation.commit.fields) {
    const nextRevision = result.fieldRevisions.get(field.fieldName);
    if (nextRevision === undefined) continue;
    const active = readActiveCandidate(
      db,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      field.fieldName,
    );
    if (active === null || active.status === "RESOLVED") continue;
    db.prepare(`
      UPDATE sync_conflict
      SET current_canonical_value = ?, current_canonical_revision = ?,
          status = 'NEEDS_REBASE', last_rebased_commit_id = ?, updated_at = ?
      WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
    `).run(
      auditJson(field.value),
      nextRevision,
      mutation.commitId,
      input.observation.receivedAt,
      active.active_candidate_conflict_id,
    );
  }
}

function maxCandidateEpoch(
  db: DatabaseSyncLike,
  rowBindingId: string,
  fieldName: string,
): number {
  const row = db.prepare(`
    SELECT MAX(candidate_epoch) AS max_epoch
    FROM sync_conflict
    WHERE row_binding_id = ? AND field_name = ?
  `).get(rowBindingId, fieldName) as { max_epoch: number | null } | undefined;
  return row?.max_epoch ?? 0;
}
