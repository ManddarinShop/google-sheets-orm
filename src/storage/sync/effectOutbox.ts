/**
 * Effect outbox claim, apply, and recovery operations.
 *
 * Per design concurrency/writer-rpc.md and storage-schema.md:
 * - Effects are claimed atomically (CAS on status = 'pending').
 * - Only one worker can claim an effect at a time.
 * - Apply results must pass fencing validation (epoch + token).
 * - Supersede/replan atomically closes old effect and inserts new one.
 */

import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { isFencingValid } from "./writerLease.js";
import type { FencingContext } from "./writerLease.js";

const FENCE_EXISTS_SQL = `
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?
`;

const CLAIM_EFFECT_SQL = `
  UPDATE sheet_effect_outbox AS candidate
  SET status = 'processing', claim_token = ?, writer_epoch = ?, lease_until = ?,
      attempts = attempts + 1
  WHERE candidate.effect_id = ?
    AND candidate.status = 'pending'
    AND EXISTS (${FENCE_EXISTS_SQL})
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
`;

const INSERT_PENDING_EFFECT_SQL = `
  INSERT INTO sheet_effect_outbox (
    effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
    projection, row_binding_id, conflict_id, target_kind, target_id,
    target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
    expected_visible_revision, expected_visible_hash, repair_guard_hash,
    source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
    stream_sequence, created_at, status
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const APPLY_EFFECT_RESULT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = ?, last_error_code = ?, last_error_message = ?,
      claim_token = NULL, lease_until = NULL
  WHERE effect_id = ?
    AND status = 'processing'
    AND claim_token = ?
    AND writer_epoch = ?
    AND lease_until IS NOT NULL
    AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const SUPERSEDE_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'superseded', supersedes_effect_id = ?
  WHERE effect_id = ?
    AND status IN ('pending', 'processing', 'blocked_candidate', 'conflict', 'failed')
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const INSERT_REPLANNED_EFFECT_SQL = `
  INSERT INTO sheet_effect_outbox (
    effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
    projection, row_binding_id, conflict_id, target_kind, target_id,
    target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
    expected_visible_revision, expected_visible_hash, repair_guard_hash,
    source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
    stream_sequence, predecessor_effect_id, created_at, status
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const RECOVER_EXPIRED_LEASES_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'failed', claim_token = NULL, lease_until = NULL,
      last_error_code = 'lease_expired_requires_postcondition',
      last_error_message = 'Read the remote postcondition before retrying this effect.'
  WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const RELEASE_UNPROCESSED_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'pending', claim_token = NULL, lease_until = NULL,
      last_error_code = 'gateway_batch_deferred',
      last_error_message = 'Gateway acknowledged a bounded batch before this effect.'
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const SELECT_PENDING_EFFECTS_BY_TARGET_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, status
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
    AND status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = sheet_effect_outbox.logical_sheet_id
        AND predecessor.target_kind = sheet_effect_outbox.target_kind
        AND predecessor.target_id = sheet_effect_outbox.target_id
        AND predecessor.stream_sequence < sheet_effect_outbox.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY stream_sequence
`;

const SELECT_READY_EFFECTS_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, status
  FROM sheet_effect_outbox AS candidate
  WHERE candidate.status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY candidate.logical_sheet_id, candidate.physical_sheet_id,
           candidate.target_kind, candidate.target_id, candidate.stream_sequence
  LIMIT ?
`;

const UPSERT_VISIBLE_STATE_SQL = `
  INSERT INTO sheet_visible_state (
    physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash,
    confirmed_visible_revision, confirmed_entity_revision, last_observed_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id)
  DO UPDATE SET
    confirmed_snapshot_hash = excluded.confirmed_snapshot_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    confirmed_entity_revision = excluded.confirmed_entity_revision,
    last_observed_hash = excluded.last_observed_hash
  WHERE sheet_visible_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

const UPSERT_VISIBLE_FIELD_STATE_SQL = `
  INSERT INTO sheet_visible_field_state (
    physical_sheet_id, projection, row_binding_id, field_name,
    confirmed_field_hash, confirmed_visible_revision, candidate_epoch,
    last_observed_field_hash
  ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
  DO UPDATE SET
    confirmed_field_hash = excluded.confirmed_field_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    last_observed_field_hash = excluded.last_observed_field_hash
  WHERE sheet_visible_field_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

export interface ClaimResult {
  readonly effectId: string;
  readonly claimToken: string;
  readonly success: boolean;
  readonly reason: "claimed" | "stale_fencing" | "not_claimable";
}

/** Input required to claim an effect with the current worker fence. */
export interface ClaimEffectOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly leaseDurationMs: number;
}

/**
 * Claims a pending effect for processing.
 * Uses CAS on status to ensure only one worker wins.
 */
export function claimEffect(db: DatabaseSyncLike, options: ClaimEffectOptions): ClaimResult {
  if (!isFencingValid(db, options)) {
    return {
      effectId: options.effectId,
      claimToken: options.claimToken,
      success: false,
      reason: "stale_fencing",
    };
  }
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "effect lease duration must be a positive safe integer",
    );
  }

  const result = db
    .prepare(CLAIM_EFFECT_SQL)
    .run(
      options.claimToken,
      options.writerEpoch,
      options.now + options.leaseDurationMs,
      options.effectId,
      ...fenceParameters(options),
    );

  const success = result.changes > 0;

  return {
    effectId: options.effectId,
    claimToken: options.claimToken,
    success,
    reason: success
      ? "claimed"
      : isFencingValid(db, options) ? "not_claimable" : "stale_fencing",
  };
}

export interface ApplyResultOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly status: "applied" | "blocked_candidate" | "superseded" | "conflict" | "failed";
  readonly lastErrorCode?: string | null;
  readonly lastErrorMessage?: string | null;
  /**
   * Gateway read-back evidence that advances confirmed projection state in the
   * same savepoint as an applied outbox result.  It is intentionally optional
   * for legacy callers that do not materialize a projection row.
   */
  readonly projectionConfirmation?: EffectProjectionConfirmation;
}

/** Confirmed projection state returned only after a gateway postcondition read. */
export interface EffectProjectionConfirmation {
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: string;
  readonly visibleRevision: number;
  readonly visibleHash: string;
  readonly entityRevision: number | null;
  readonly fieldHashes: Readonly<Record<string, string>>;
}

/** A pending outbox row prepared by the writer transaction. */
export interface NewEffect {
  readonly effectId: string;
  readonly effectKind: string;
  readonly commitId: string;
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: string | null;
  readonly conflictId: string | null;
  readonly targetKind: string;
  readonly targetId: string;
  readonly targetEntityRevision: number | null;
  readonly targetFieldRevisionHash: string | null;
  readonly targetCanonicalCommitId: string | null;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: string | null;
  readonly sourceQuarantineId: string | null;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly effectDedupeKey: string;
  readonly streamSequence: number;
}

/**
 * Appends pending effects under the supplied writer fence.
 *
 * This is used for conflict/quarantine effects that do not accompany a
 * canonical field commit. It owns a savepoint so a duplicate dedupe key or a
 * lost fence cannot leave only part of an effect set behind.
 */
export function appendPendingEffects(
  db: DatabaseSyncLike,
  fence: FencingContext,
  effects: readonly NewEffect[],
): boolean {
  if (effects.length === 0) return isFencingValid(db, fence);
  if (!isFencingValid(db, fence)) return false;

  db.exec("SAVEPOINT append_pending_effects");
  try {
    for (const effect of effects) {
      const result = db.prepare(INSERT_PENDING_EFFECT_SQL).run(
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
      if (result.changes !== 1) {
        if (!isFencingValid(db, fence)) {
          db.exec("ROLLBACK TO append_pending_effects");
          db.exec("RELEASE append_pending_effects");
          return false;
        }
        throw new StorageError(
          STORAGE_ERROR_CODES.EFFECT_WRITE_FAILED,
          `could not insert effect ${effect.effectId}`,
        );
      }
    }
    db.exec("RELEASE append_pending_effects");
    return true;
  } catch (error: unknown) {
    db.exec("ROLLBACK TO append_pending_effects");
    db.exec("RELEASE append_pending_effects");
    throw error;
  }
}

/**
 * Applies a result to a claimed effect.
 * Validates fencing (claim token + writer epoch) before applying.
 * Returns true if the result was applied, false if fencing failed.
 */
export function applyEffectResult(db: DatabaseSyncLike, options: ApplyResultOptions): boolean {
  if (!isFencingValid(db, options)) {
    return false;
  }
  if (options.status !== "applied" && options.projectionConfirmation !== undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
      "only an applied effect may advance confirmed projection state",
    );
  }
  if (options.projectionConfirmation !== undefined) {
    validateProjectionConfirmation(options.projectionConfirmation);
  }

  db.exec("SAVEPOINT apply_effect_result");
  try {
    const result = db
      .prepare(APPLY_EFFECT_RESULT_SQL)
      .run(
        options.status,
        options.lastErrorCode ?? null,
        options.lastErrorMessage ?? null,
        options.effectId,
        options.claimToken,
        options.writerEpoch,
        options.now,
        ...fenceParameters(options),
      );

    if (result.changes !== 1) {
      db.exec("ROLLBACK TO apply_effect_result");
      db.exec("RELEASE apply_effect_result");
      return false;
    }
    if (options.projectionConfirmation !== undefined) {
      writeProjectionConfirmation(db, options.projectionConfirmation);
    }
    db.exec("RELEASE apply_effect_result");
    return true;
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK TO apply_effect_result");
      db.exec("RELEASE apply_effect_result");
    } catch {
      // Preserve the storage error that caused the result write to fail.
    }
    throw error;
  }
}

/**
 * Supersedes an old effect and inserts a new replacement effect atomically.
 * Used for repair replan when the canonical target has advanced.
 *
 * Per design: the old effect is marked 'superseded', a new effect with a new
 * effect_id and new dedupe_key is inserted, and the new effect's
 * predecessor_effect_id links to the old one.
 */
export function supersedeAndReplan(
  db: DatabaseSyncLike,
  fence: FencingContext,
  oldEffectId: string,
  newEffect: NewEffect,
): void {
  requireCurrentFence(db, fence);
  db.exec("SAVEPOINT replan");
  try {
    const superseded = db.prepare(SUPERSEDE_EFFECT_SQL)
      .run(newEffect.effectId, oldEffectId, ...fenceParameters(fence));
    if (superseded.changes !== 1) {
      requireCurrentFence(db, fence);
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT,
        `effect ${oldEffectId} cannot be replanned from its current status`,
      );
    }

    const inserted = db.prepare(INSERT_REPLANNED_EFFECT_SQL).run(
      newEffect.effectId,
      newEffect.effectKind,
      newEffect.commitId,
      newEffect.logicalSheetId,
      newEffect.physicalSheetId,
      newEffect.projection,
      newEffect.rowBindingId,
      newEffect.conflictId,
      newEffect.targetKind,
      newEffect.targetId,
      newEffect.targetEntityRevision,
      newEffect.targetFieldRevisionHash,
      newEffect.targetCanonicalCommitId,
      newEffect.expectedVisibleRevision,
      newEffect.expectedVisibleHash,
      newEffect.repairGuardHash,
      newEffect.sourceQuarantineId,
      newEffect.payloadJson,
      newEffect.payloadHash,
      newEffect.effectDedupeKey,
      newEffect.streamSequence,
      oldEffectId,
      fence.now,
      ...fenceParameters(fence),
    );
    if (inserted.changes !== 1) {
      requireCurrentFence(db, fence);
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_WRITE_FAILED,
        `effect ${newEffect.effectId} could not be inserted during replan`,
      );
    }

    db.exec("RELEASE replan");
  } catch (error) {
    db.exec("ROLLBACK TO replan");
    db.exec("RELEASE replan");
    throw error;
  }
}

/**
 * Marks expired processing effects as requiring postcondition recovery.
 *
 * The worker must read the remote postcondition before it schedules a retry;
 * an expired lease is not evidence that the remote write did not happen.
 */
export function recoverExpiredLeases(
  db: DatabaseSyncLike,
  fence: FencingContext,
): number {
  requireCurrentFence(db, fence);
  const result = db
    .prepare(RECOVER_EXPIRED_LEASES_SQL)
    .run(fence.now, ...fenceParameters(fence));
  return result.changes;
}

/**
 * Returns an acknowledged-but-unprocessed batch suffix to pending.
 *
 * This is intentionally narrower than a generic redrive: it may be used only
 * after a valid gateway response explicitly says the batch budget stopped
 * before this effect.  Unknown response loss remains failed until read-back.
 */
export function releaseUnprocessedEffect(
  db: DatabaseSyncLike,
  options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
    readonly effectId: string;
    readonly claimToken: string;
  },
): boolean {
  if (!isFencingValid(db, options)) return false;
  const result = db.prepare(RELEASE_UNPROCESSED_EFFECT_SQL).run(
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  );
  return result.changes === 1;
}

/**
 * Finds pending effects for a given stream (target), ordered by stream_sequence.
 * Returns the head-of-line effects for a target stream.
 */
export function findPendingEffectsByTarget(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): readonly PendingEffect[] {
  return db
    .prepare(SELECT_PENDING_EFFECTS_BY_TARGET_SQL)
    .all(logicalSheetId, targetKind, targetId) as PendingEffect[];
}

/**
 * Returns ordered head-of-line effects across streams for one bounded worker pass.
 *
 * Claiming still performs the authoritative CAS, so a concurrent worker can
 * safely race this advisory selection without processing a later stream item.
 */
export function listReadyEffects(
  db: DatabaseSyncLike,
  limit: number,
): readonly PendingEffect[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready effect limit must be a positive safe integer",
    );
  }
  return db.prepare(SELECT_READY_EFFECTS_SQL).all(limit) as PendingEffect[];
}

export interface PendingEffect {
  readonly effect_id: string;
  readonly effect_kind: string;
  readonly commit_id: string;
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly row_binding_id: string | null;
  readonly conflict_id: string | null;
  readonly target_kind: string;
  readonly target_id: string;
  readonly target_entity_revision: number | null;
  readonly target_field_revision_hash: string | null;
  readonly target_canonical_commit_id: string | null;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly repair_guard_hash: string | null;
  readonly source_quarantine_id: string | null;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly effect_dedupe_key: string;
  readonly stream_sequence: number;
  readonly created_at: number;
  readonly status: string;
}

function validateProjectionConfirmation(confirmation: EffectProjectionConfirmation): void {
  if (
    confirmation.physicalSheetId.length === 0 ||
    confirmation.projection.length === 0 ||
    confirmation.rowBindingId.length === 0 ||
    confirmation.visibleHash.length === 0 ||
    !Number.isSafeInteger(confirmation.visibleRevision) ||
    confirmation.visibleRevision < 1
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_PROJECTION_CONFIRMATION,
      "projection confirmation has an invalid identity or visible revision",
    );
  }
  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    if (fieldName.length === 0 || hash.length === 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_PROJECTION_CONFIRMATION,
        "projection confirmation contains an invalid field hash",
      );
    }
  }
}

/** Writes row and field confirmation only after the outbox effect has won its claim CAS. */
function writeProjectionConfirmation(
  db: DatabaseSyncLike,
  confirmation: EffectProjectionConfirmation,
): void {
  const row = db.prepare(UPSERT_VISIBLE_STATE_SQL).run(
    confirmation.physicalSheetId,
    confirmation.projection,
    confirmation.rowBindingId,
    confirmation.visibleHash,
    confirmation.visibleRevision,
    confirmation.entityRevision,
    confirmation.visibleHash,
  );
  if (row.changes !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
      "projection confirmation would move visible state backwards",
    );
  }

  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    const field = db.prepare(UPSERT_VISIBLE_FIELD_STATE_SQL).run(
      confirmation.physicalSheetId,
      confirmation.projection,
      confirmation.rowBindingId,
      fieldName,
      hash,
      confirmation.visibleRevision,
      hash,
    );
    if (field.changes !== 1) {
      throw new StorageError(
        STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
        "projection confirmation would move a field visible state backwards",
      );
    }
  }
}

function requireCurrentFence(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "writer fencing is stale or expired",
    );
  }
}

function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}
