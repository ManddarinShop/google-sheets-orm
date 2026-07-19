/**
 * Restore-reconciliation gate for a restored SQLite backup.
 *
 * A backup is inspected read-only first. The writable restored copy then
 * invalidates every pre-restore writer fence and remains unable to authorize
 * Sheet effects until the caller records completed reconciliation.
 */

import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { withImmediateTransaction } from "../sqlite/sqliteBridge.js";

/** Immutable facts verified from a read-only backup before restoration begins. */
export interface RestoreInspection {
  readonly sourceCutoverId: string;
  readonly sourceSnapshotHash: string;
  readonly marker: string;
  readonly priorLeaseRoles: readonly string[];
}

/** Input used to begin the persisted restore reconciliation gate. */
export interface BeginRestoreReconciliationOptions {
  readonly restoreId: string;
  readonly now: number;
}

/** A restore that has invalidated old fences but cannot yet write Sheets. */
export interface RestoreReconciliation {
  readonly restoreId: string;
  readonly sourceCutoverId: string;
  readonly sourceSnapshotHash: string;
  readonly invalidatedLeaseCount: number;
  readonly sheetWritesAllowed: false;
}

/** The only outcomes a caller may record after a remote effect postcondition read-back. */
export type RestoreEffectDisposition = "applied" | "superseded" | "replan_required";

/** One remote effect outcome used to close restore reconciliation. */
export interface RestoreEffectReconciliation {
  readonly effectId: string;
  readonly disposition: RestoreEffectDisposition;
}

/** Input required to mark a restore reconciliation gate as ready. */
export interface CompleteRestoreReconciliationOptions {
  readonly effects: readonly RestoreEffectReconciliation[];
}

/** A restore whose caller has recorded reconciliation and may resume Sheet writes. */
export interface ReadyRestore {
  readonly restoreId: string;
  readonly sheetWritesAllowed: true;
}

/**
 * Verifies the essential schema and cutover marker through a read-only backup
 * connection. It intentionally performs no replay or lease mutation.
 */
export function inspectRestoredBackup(
  readOnlyDb: DatabaseSyncLike,
  sourceCutoverId: string,
): RestoreInspection {
  requireNonEmptyText(sourceCutoverId, "source cutover ID");
  for (const tableName of [
    "entity_state",
    "sheet_effect_outbox",
    "writer_lease",
    "cutover_state",
  ]) {
    const table = readOnlyDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(tableName) as { name: string } | undefined;
    if (table === undefined) {
      throw new Error("restored backup is missing required table: " + tableName);
    }
  }

  const marker = readOnlyDb.prepare(`
    SELECT cutover_id, source_snapshot_hash, marker
    FROM cutover_state
    WHERE cutover_id = ?
  `).get(sourceCutoverId) as
    | { cutover_id: string; source_snapshot_hash: string | null; marker: string | null }
    | undefined;
  if (
    marker === undefined ||
    marker.source_snapshot_hash === null ||
    marker.marker === null
  ) {
    throw new Error("restored backup is missing the required cutover marker and source snapshot hash");
  }

  const leaseRows = readOnlyDb.prepare(
    "SELECT role FROM writer_lease ORDER BY role",
  ).all() as readonly { role: string }[];

  return {
    sourceCutoverId: marker.cutover_id,
    sourceSnapshotHash: marker.source_snapshot_hash,
    marker: marker.marker,
    priorLeaseRoles: leaseRows.map((lease) => lease.role),
  };
}

/**
 * Persists a reconciliation gate and invalidates every pre-restore lease.
 *
 * The caller must still read current Sheet postconditions. This function only
 * prevents an old fence from being reused and keeps future Sheet writes gated.
 */
export function beginRestoreReconciliation(
  db: DatabaseSyncLike,
  inspection: RestoreInspection,
  options: BeginRestoreReconciliationOptions,
): RestoreReconciliation {
  requireNonEmptyText(options.restoreId, "restore ID");
  requireNonNegativeSafeInteger(options.now, "restore time");

  const result = withImmediateTransaction(db, () => {
    const sourceMarker = db.prepare(`
      SELECT source_snapshot_hash, marker
      FROM cutover_state
      WHERE cutover_id = ?
    `).get(inspection.sourceCutoverId) as
      | { source_snapshot_hash: string | null; marker: string | null }
      | undefined;
    if (
      sourceMarker === undefined ||
      sourceMarker.source_snapshot_hash !== inspection.sourceSnapshotHash ||
      sourceMarker.marker !== inspection.marker
    ) {
      throw new Error("restore inspection does not match the restored cutover marker");
    }

    const existing = db.prepare(
      "SELECT cutover_id FROM cutover_state WHERE cutover_id = ?",
    ).get(options.restoreId);
    if (existing !== undefined) {
      throw new Error("restore ID already exists: " + options.restoreId);
    }

    const invalidated = db.prepare(
      "UPDATE writer_lease SET lease_until = ?",
    ).run(options.now);
    db.prepare(`
      INSERT INTO cutover_state (
        cutover_id, phase, source_snapshot_hash, marker, status, created_at
      ) VALUES (?, 'restore_reconciliation', ?, ?, 'reconciling', ?)
    `).run(
      options.restoreId,
      inspection.sourceSnapshotHash,
      inspection.marker,
      options.now,
    );
    return invalidated.changes;
  });

  return {
    restoreId: options.restoreId,
    sourceCutoverId: inspection.sourceCutoverId,
    sourceSnapshotHash: inspection.sourceSnapshotHash,
    invalidatedLeaseCount: result,
    sheetWritesAllowed: false,
  };
}

/**
 * Records that each relevant effect has been classified by a read-back caller.
 * It does not replay events or turn expired processing effects back to pending.
 */
export function completeRestoreReconciliation(
  db: DatabaseSyncLike,
  restore: RestoreReconciliation,
  options: CompleteRestoreReconciliationOptions,
): ReadyRestore {
  validateEffectReconciliation(options.effects);

  withImmediateTransaction(db, () => {
    const result = db.prepare(`
      UPDATE cutover_state
      SET status = 'reconciled'
      WHERE cutover_id = ? AND phase = 'restore_reconciliation' AND status = 'reconciling'
    `).run(restore.restoreId);
    if (result.changes !== 1) {
      throw new Error("restore reconciliation is not pending: " + restore.restoreId);
    }
  });

  return { restoreId: restore.restoreId, sheetWritesAllowed: true };
}

/** Rejects a Sheet write until the persisted restore reconciliation status is complete. */
export function requireRestoreAllowsSheetWrites(db: DatabaseSyncLike, restoreId: string): void {
  requireNonEmptyText(restoreId, "restore ID");
  const row = db.prepare(`
    SELECT status
    FROM cutover_state
    WHERE cutover_id = ? AND phase = 'restore_reconciliation'
  `).get(restoreId) as { status: string } | undefined;
  if (row === undefined || row.status !== "reconciled") {
    throw new Error("restore reconciliation has not completed: " + restoreId);
  }
}

function validateEffectReconciliation(effects: readonly RestoreEffectReconciliation[]): void {
  const effectIds = new Set<string>();
  for (const effect of effects) {
    requireNonEmptyText(effect.effectId, "reconciled effect ID");
    if (effectIds.has(effect.effectId)) {
      throw new Error("duplicate reconciled effect ID: " + effect.effectId);
    }
    effectIds.add(effect.effectId);
  }
}

function requireNonEmptyText(value: string, label: string): void {
  if (value.length === 0) throw new Error(label + " is required");
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(label + " must be a non-negative safe integer");
  }
}
