/**
 * Durable, fenced storage mapping for trusted conflict-resolution commands.
 *
 * The pure core decides whether an acknowledgement is resolved, stale, or
 * rejected. This module records that decision with the command receipt,
 * clears only the currently active candidate pointer, and queues any
 * resolution projection effect in one SQLite transaction.
 */

import { applyResolution } from "../../core/index.js";
import type {
  ConflictStatus,
  NormalizedCell,
  ResolutionCommand,
  SyncConflict,
} from "../../core/index.js";
import { appendPendingEffects, type NewEffect } from "../sync/effectOutbox.js";
import { withImmediateTransaction, type DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { isFencingValid, type FencingContext } from "../sync/writerLease.js";

/** Input required to durably process one trusted `acknowledge_system` request. */
export interface PersistResolutionCommandInput {
  readonly logicalSheetId: string;
  readonly command: ResolutionCommand;
  /** Durable transaction identity for effects created by this resolution. */
  readonly commitId: string;
  /** Effects to materialize after a successful acknowledge_system transition. */
  readonly effects: readonly NewEffect[];
  /**
   * Effects to materialize when the request is stale. This normally consumes a
   * checked control cell while projecting NEEDS_REBASE rather than retrying an
   * old acknowledgement forever.
   */
  readonly staleEffects?: readonly NewEffect[];
  /** Effects to materialize when a trusted request is rejected. */
  readonly rejectedEffects?: readonly NewEffect[];
  /**
   * Effects to materialize when a replay reaches an already terminal command.
   * This normally resets a still-checked one-shot control without reopening or
   * reapplying the canonical resolution.
   */
  readonly duplicateEffects?: readonly NewEffect[];
}

/** Terminal or replay-visible result of a resolution command transaction. */
export type PersistResolutionCommandResult =
  | { readonly kind: "fenced_out" }
  | { readonly kind: "applied"; readonly commandId: string; readonly conflictId: string }
  | { readonly kind: "stale"; readonly commandId: string; readonly conflictId: string }
  | { readonly kind: "rejected"; readonly commandId: string; readonly reason: string }
  | {
      readonly kind: "duplicate";
      readonly commandId: string;
      readonly status: "processing" | "applied" | "stale" | "rejected" | "failed";
    };

interface ConflictRow {
  readonly conflict_id: string;
  readonly conflict_group_id: string | null;
  readonly event_id: string;
  readonly row_binding_id: string;
  readonly entity_id: string;
  readonly field_name: string;
  readonly user_value: string;
  readonly user_base_revision: number;
  readonly canonical_value_at_detection: string;
  readonly canonical_revision_at_detection: number;
  readonly current_canonical_value: string;
  readonly current_canonical_revision: number;
  readonly candidate_epoch: number;
  readonly status: string;
  readonly resolution_command_id: string | null;
}

interface CommandRow {
  readonly command_id: string;
  readonly request_key: string;
  readonly action: string;
  readonly actor_id: string;
  readonly role: string;
  readonly target_conflict_id: string;
  readonly expected_revision: number;
  readonly active_candidate_hash: string;
  readonly expected_candidate_epoch: number;
  readonly payload_hash: string;
  readonly status: "processing" | "applied" | "stale" | "rejected" | "failed";
}

interface ActiveCandidatePointer {
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly candidate_epoch: number;
  readonly active_candidate_hash: string;
}

/**
 * Persists a resolution command at the writer-RPC boundary.
 *
 * An old command is stale unless the target conflict is still the active
 * candidate pointer for its field. That extra pointer check closes the
 * storage-level ABA gap that a historical conflict row alone cannot detect.
 */
export function persistResolutionCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): PersistResolutionCommandResult {
  validateInput(input);
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };

  try {
    return withImmediateTransaction(db, () => {
      assertCurrentFence(db, fence);
      const duplicate = findExistingCommand(db, input.command);
      if (duplicate !== null) {
        // A durable processing receipt already owns the request. Only a terminal
        // replay may consume a still-checked control with a reset projection.
        if (duplicate.status !== "processing") {
          appendResolutionEffects(db, fence, input, input.duplicateEffects ?? []);
        }
        return duplicate;
      }

      const conflict = readConflict(db, input.logicalSheetId, input.command.targetConflictId);
      if (conflict === null) {
        return {
          kind: "rejected",
          commandId: input.command.commandId,
          reason: "target conflict does not exist in the logical sheet",
        };
      }

      insertProcessingCommand(db, fence, input);
      const pointer = readActiveCandidatePointer(db, conflict);
      const transition = pointer !== null &&
        pointer.candidate_epoch === input.command.expectedCandidateEpoch &&
        pointer.active_candidate_hash === input.command.activeCandidateHash
        ? applyResolution(conflict, input.command)
        : { kind: "stale" as const, conflict };

      if (transition.kind === "resolved") {
        applyResolvedCommand(db, fence, input, conflict, pointer);
        return {
          kind: "applied",
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
        };
      }
      if (transition.kind === "stale") {
        markStaleCommand(db, fence, input, transition.conflict.status);
        return {
          kind: "stale",
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
        };
      }

      markRejectedCommand(db, fence, input);
      return {
        kind: "rejected",
        commandId: input.command.commandId,
        reason: transition.reason,
      };
    });
  } catch (error: unknown) {
    if (error instanceof FenceLostError) return { kind: "fenced_out" };
    throw error;
  }
}

function validateInput(input: PersistResolutionCommandInput): void {
  if (input.logicalSheetId.length === 0 || input.commitId.length === 0) {
    throw new Error("logical sheet ID and resolution commit ID are required");
  }
  const command = input.command;
  if (
    command.commandId.length === 0 ||
    command.requestKey.length === 0 ||
    command.actorId.length === 0 ||
    command.targetConflictId.length === 0 ||
    command.activeCandidateHash.length === 0 ||
    command.payloadHash.length === 0 ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Number.isSafeInteger(command.expectedCandidateEpoch) ||
    command.expectedCandidateEpoch < 0
  ) {
    throw new Error("resolution command has an invalid durable identity or CAS input");
  }
  for (const effect of allResolutionEffects(input)) {
    const isConflictControlProjection =
      effect.projection === "sync_conflicts" &&
      effect.targetKind === "conflict" &&
      effect.conflictId === command.targetConflictId;
    if (effect.logicalSheetId !== input.logicalSheetId && !isConflictControlProjection) {
      throw new Error("resolution effect belongs to a different logical sheet");
    }
  }
}

function findExistingCommand(
  db: DatabaseSyncLike,
  command: ResolutionCommand,
): Extract<PersistResolutionCommandResult, { readonly kind: "duplicate" }> | null {
  const rows = db.prepare(`
    SELECT command_id, request_key, action, actor_id, role, target_conflict_id,
           expected_revision, active_candidate_hash, expected_candidate_epoch,
           payload_hash, status
    FROM resolution_command
    WHERE command_id = ? OR request_key = ?
  `).all(command.commandId, command.requestKey) as CommandRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("resolution command identity is internally inconsistent");
  const existing = rows[0];
  if (existing === undefined) throw new Error("resolution command lookup unexpectedly lost its row");
  if (!sameCommandIdentity(existing, command)) {
    throw new Error("resolution command ID or request key was replayed with a different payload");
  }
  return { kind: "duplicate", commandId: existing.command_id, status: existing.status };
}

function sameCommandIdentity(existing: CommandRow, command: ResolutionCommand): boolean {
  return existing.command_id === command.commandId &&
    existing.request_key === command.requestKey &&
    existing.action === command.action &&
    existing.actor_id === command.actorId &&
    existing.role === command.role &&
    existing.target_conflict_id === command.targetConflictId &&
    existing.expected_revision === command.expectedRevision &&
    existing.active_candidate_hash === command.activeCandidateHash &&
    existing.expected_candidate_epoch === command.expectedCandidateEpoch &&
    existing.payload_hash === command.payloadHash;
}

function readConflict(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  conflictId: string,
): SyncConflict | null {
  const row = db.prepare(`
    SELECT conflict_id, conflict_group_id, event_id, row_binding_id, entity_id, field_name,
           user_value, user_base_revision, canonical_value_at_detection,
           canonical_revision_at_detection, current_canonical_value,
           current_canonical_revision, candidate_epoch, status, resolution_command_id
    FROM sync_conflict
    WHERE logical_sheet_id = ? AND conflict_id = ?
  `).get(logicalSheetId, conflictId) as ConflictRow | undefined;
  if (row === undefined) return null;
  return {
    conflictId: row.conflict_id,
    conflictGroupId: row.conflict_group_id,
    eventId: row.event_id,
    rowBindingId: row.row_binding_id,
    entityId: row.entity_id,
    fieldName: row.field_name,
    userValue: parseNormalizedCell(row.user_value, "user_value"),
    userBaseRevision: row.user_base_revision,
    canonicalValueAtDetection: parseNormalizedCell(
      row.canonical_value_at_detection,
      "canonical_value_at_detection",
    ),
    canonicalRevisionAtDetection: row.canonical_revision_at_detection,
    currentCanonicalValue: parseNormalizedCell(row.current_canonical_value, "current_canonical_value"),
    currentCanonicalRevision: row.current_canonical_revision,
    candidateEpoch: row.candidate_epoch,
    status: requireConflictStatus(row.status),
    resolutionCommandId: row.resolution_command_id,
  };
}

function readActiveCandidatePointer(
  db: DatabaseSyncLike,
  conflict: SyncConflict,
): ActiveCandidatePointer | null {
  const rows = db.prepare(`
    SELECT physical_sheet_id, projection, candidate_epoch, active_candidate_hash
    FROM sheet_visible_field_state
    WHERE row_binding_id = ? AND field_name = ?
      AND active_candidate_conflict_id = ?
      AND active_candidate_hash IS NOT NULL
  `).all(conflict.rowBindingId, conflict.fieldName, conflict.conflictId) as ActiveCandidatePointer[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error("a conflict cannot be active in more than one physical projection");
  }
  return rows[0] ?? null;
}

function insertProcessingCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): void {
  const command = input.command;
  const result = db.prepare(`
    INSERT INTO resolution_command (
      command_id, request_key, action, actor_id, role, target_conflict_id,
      expected_revision, active_candidate_hash, expected_candidate_epoch,
      payload_hash, status, issued_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?
    WHERE EXISTS (${fenceExistsSql()})
  `).run(
    command.commandId,
    command.requestKey,
    command.action,
    command.actorId,
    command.role,
    command.targetConflictId,
    command.expectedRevision,
    command.activeCandidateHash,
    command.expectedCandidateEpoch,
    command.payloadHash,
    fence.now,
    ...fenceParameters(fence),
  );
  if (result.changes !== 1) throw new FenceLostError();
}

function applyResolvedCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  conflict: SyncConflict,
  pointer: ActiveCandidatePointer | null,
): void {
  if (pointer === null) throw new Error("resolved command lost its active candidate pointer");
  const command = input.command;
  const conflictResult = db.prepare(`
    UPDATE sync_conflict
    SET status = 'RESOLVED', resolution_command_id = ?, updated_at = ?
    WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
      AND current_canonical_revision = ? AND candidate_epoch = ?
      AND EXISTS (${fenceExistsSql()})
  `).run(
    command.commandId,
    fence.now,
    conflict.conflictId,
    command.expectedRevision,
    command.expectedCandidateEpoch,
    ...fenceParameters(fence),
  );
  if (conflictResult.changes !== 1) throw new FenceLostError();

  const clearedPointer = db.prepare(`
    UPDATE sheet_visible_field_state
    SET active_candidate_conflict_id = NULL, active_candidate_hash = NULL,
        candidate_epoch = candidate_epoch + 1
    WHERE physical_sheet_id = ? AND projection = ?
      AND row_binding_id = ? AND field_name = ?
      AND active_candidate_conflict_id = ? AND candidate_epoch = ?
      AND EXISTS (${fenceExistsSql()})
  `).run(
    pointer.physical_sheet_id,
    pointer.projection,
    conflict.rowBindingId,
    conflict.fieldName,
    conflict.conflictId,
    command.expectedCandidateEpoch,
    ...fenceParameters(fence),
  );
  if (clearedPointer.changes !== 1) throw new FenceLostError();

  const binding = db.prepare(`
    UPDATE row_binding
    SET candidate_epoch = CASE
      WHEN candidate_epoch <= ? THEN ?
      ELSE candidate_epoch
    END
    WHERE row_binding_id = ? AND logical_sheet_id = ?
      AND EXISTS (${fenceExistsSql()})
  `).run(
    command.expectedCandidateEpoch,
    command.expectedCandidateEpoch + 1,
    conflict.rowBindingId,
    input.logicalSheetId,
    ...fenceParameters(fence),
  );
  if (binding.changes !== 1) throw new FenceLostError();

  appendResolutionEffects(db, fence, input, input.effects);
  const commandResult = db.prepare(`
    UPDATE resolution_command
    SET status = 'applied', applied_commit_id = ?
    WHERE command_id = ? AND status = 'processing'
      AND EXISTS (${fenceExistsSql()})
  `).run(input.commitId, command.commandId, ...fenceParameters(fence));
  if (commandResult.changes !== 1) throw new FenceLostError();
}

function markStaleCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  nextConflictStatus: ConflictStatus,
): void {
  db.prepare(`
    UPDATE sync_conflict
    SET status = ?, updated_at = ?
    WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
      AND EXISTS (${fenceExistsSql()})
  `).run(
    nextConflictStatus,
    fence.now,
    input.command.targetConflictId,
    ...fenceParameters(fence),
  );
  const command = db.prepare(`
    UPDATE resolution_command
    SET status = 'stale'
    WHERE command_id = ? AND status = 'processing'
      AND EXISTS (${fenceExistsSql()})
  `).run(input.command.commandId, ...fenceParameters(fence));
  if (command.changes !== 1) throw new FenceLostError();
  appendResolutionEffects(db, fence, input, input.staleEffects ?? []);
}

function markRejectedCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): void {
  const result = db.prepare(`
    UPDATE resolution_command
    SET status = 'rejected'
    WHERE command_id = ? AND status = 'processing'
      AND EXISTS (${fenceExistsSql()})
  `).run(input.command.commandId, ...fenceParameters(fence));
  if (result.changes !== 1) throw new FenceLostError();
  appendResolutionEffects(db, fence, input, input.rejectedEffects ?? []);
}

/** Registers a branch's projection effects in the same writer transaction as the command receipt. */
function appendResolutionEffects(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  effects: readonly NewEffect[],
): void {
  if (effects.length === 0) return;
  ensureResolutionEffectsRegistered(db, input, effects);
  const unseen = effects.filter((effect) => {
    const existing = db.prepare(`
      SELECT effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
             projection, target_kind, target_id, payload_hash
      FROM sheet_effect_outbox
      WHERE effect_dedupe_key = ?
    `).get(effect.effectDedupeKey) as
      | {
        effect_kind: string;
        commit_id: string;
        logical_sheet_id: string;
        physical_sheet_id: string;
        projection: string;
        target_kind: string;
        target_id: string;
        payload_hash: string;
      }
      | undefined;
    if (existing === undefined) return true;
    if (
      existing.effect_kind !== effect.effectKind ||
      existing.commit_id !== effect.commitId ||
      existing.logical_sheet_id !== effect.logicalSheetId ||
      existing.physical_sheet_id !== effect.physicalSheetId ||
      existing.projection !== effect.projection ||
      existing.target_kind !== effect.targetKind ||
      existing.target_id !== effect.targetId ||
      existing.payload_hash !== effect.payloadHash
    ) {
      throw new Error("resolution effect dedupe key was reused with a different payload");
    }
    return false;
  });
  if (unseen.length > 0 && !appendPendingEffects(db, fence, unseen)) throw new FenceLostError();
}

/** Ensures no resolution branch can enqueue an effect for a foreign or disabled projection. */
function ensureResolutionEffectsRegistered(
  db: DatabaseSyncLike,
  input: PersistResolutionCommandInput,
  effects: readonly NewEffect[],
): void {
  for (const effect of effects) {
    const target = db.prepare(`
      SELECT logical_sheet_id, projection, enabled
      FROM physical_sheet_registry
      WHERE physical_sheet_id = ?
    `).get(effect.physicalSheetId) as
      | { logical_sheet_id: string; projection: string; enabled: number }
      | undefined;
    if (
      target === undefined ||
      target.logical_sheet_id !== effect.logicalSheetId ||
      target.projection !== effect.projection ||
      target.enabled !== 1
    ) {
      throw new Error("resolution effect targets an unregistered physical projection");
    }
  }
}

/** Returns every branch effect so structural validation remains uniform. */
function allResolutionEffects(input: PersistResolutionCommandInput): readonly NewEffect[] {
  return [
    ...input.effects,
    ...(input.staleEffects ?? []),
    ...(input.rejectedEffects ?? []),
    ...(input.duplicateEffects ?? []),
  ];
}

function parseNormalizedCell(serialized: string, fieldName: string): NormalizedCell {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`stored ${fieldName} is not valid JSON`);
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`stored ${fieldName} is not a normalized cell`);
  }
  const cell = value as { readonly kind?: unknown; readonly value?: unknown };
  if (cell.kind === "string" && typeof cell.value === "string") {
    return { kind: "string", value: cell.value };
  }
  if (cell.kind === "number" && typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return { kind: "number", value: cell.value };
  }
  if (cell.kind === "boolean" && typeof cell.value === "boolean") {
    return { kind: "boolean", value: cell.value };
  }
  if (cell.kind === "date" && typeof cell.value === "string" && isCanonicalDate(cell.value)) {
    return { kind: "date", value: cell.value };
  }
  throw new Error(`stored ${fieldName} is not a normalized cell`);
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function requireConflictStatus(value: string): ConflictStatus {
  if (value === "OPEN" || value === "NEEDS_REBASE" || value === "RESOLVED") return value;
  throw new Error(`stored conflict has invalid status ${value}`);
}

function assertCurrentFence(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) throw new FenceLostError();
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

class FenceLostError extends Error {}
