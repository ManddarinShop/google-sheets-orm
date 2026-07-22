/**
 * Restart-safe migration/cutover coordinator.
 *
 * The old queue remains the only writer until every persisted gate has passed.
 * External queue operations are deliberately small/idempotent interfaces so a
 * process crash between an external call and SQLite checkpoint can safely run
 * the same phase again without enabling dual writers.
 */

import { stableHash } from "../../core/index.js";
import {
  isFencingValid,
  withImmediateTransaction,
  type DatabaseSyncLike,
  type FencingContext,
} from "../../storage/index.js";

/** Legacy queue controls that must be idempotent during cutover recovery. */
export interface LegacyQueueCutoverControl {
  /** Blocks new legacy writes and returns the snapshot it froze at. */
  freezeWrites(): Promise<{ readonly sourceSnapshotHash: string }>;
  /** Returns the number of old tasks that still could write the Sheet. */
  pendingTaskCount(): Promise<number>;
  /** Drains a bounded queue until a later pendingTaskCount() proves zero. */
  drainPendingTasks(): Promise<void>;
  /** Disables the legacy writer after a zero-pending checkpoint. */
  disableWriter(): Promise<void>;
}

/** Writer-owned callbacks for the new SQLite side of migration. */
export interface CutoverNewRuntimeControl {
  /** Seeds anchors/bindings/revisions and returns a stable seed checkpoint. */
  seed(): Promise<{ readonly seedHash: string; readonly fencedOut?: boolean }>;
  /** Compares SQLite shadow state to the Sheet without applying projection writes. */
  shadowDiff(): Promise<{ readonly matches: boolean; readonly snapshotHash: string; readonly detailHash: string }>;
  /** Enables the new writer only after old writer disable is checkpointed. */
  activateWriter(): Promise<void>;
}

/** Inputs for one resumable cutover attempt. */
export interface RunCutoverOptions {
  readonly database: DatabaseSyncLike;
  readonly fence: FencingContext;
  readonly cutoverId: string;
  readonly sourceSnapshotHash: string;
  readonly now: number;
  readonly legacy: LegacyQueueCutoverControl;
  readonly next: CutoverNewRuntimeControl;
}

/** Persisted cutover state visible after a run, block, retry, or completion. */
export interface CutoverState {
  readonly cutoverId: string;
  readonly phase: CutoverPhase;
  readonly sourceSnapshotHash: string;
  readonly marker: string | null;
  readonly status: "running" | "blocked" | "complete" | "fenced_out";
}

/** Ordered phases; every transition is persisted before the next phase begins. */
export type CutoverPhase =
  | "freeze_legacy"
  | "drain_legacy"
  | "seed_projection"
  | "shadow_diff"
  | "mark_cutover"
  | "disable_legacy"
  | "activate_new_writer"
  | "complete";

/**
 * Runs all currently reachable cutover phases, stopping at the first real gate.
 *
 * A blocked result does not activate the new writer. Re-running after an
 * operator resolves the condition resumes from the stored phase and checks the
 * same source snapshot hash before it does any additional work.
 */
export async function runCutover(options: RunCutoverOptions): Promise<CutoverState> {
  validateOptions(options);
  let state = loadOrCreateCutover(options);
  if (state.status === "fenced_out" || state.phase === "complete") return state;

  while (true) {
    if (!isFencingValid(options.database, options.fence)) {
      return markFencedOut(options, state);
    }
    if (state.phase === "freeze_legacy") {
      const frozen = await options.legacy.freezeWrites();
      if (frozen.sourceSnapshotHash !== options.sourceSnapshotHash) {
        return block(options, state, "legacy freeze snapshot does not match requested cutover source");
      }
      state = advance(options, state, "drain_legacy", "running", state.marker);
      continue;
    }
    if (state.phase === "drain_legacy") {
      let pending = await options.legacy.pendingTaskCount();
      if (pending > 0) {
        await options.legacy.drainPendingTasks();
        pending = await options.legacy.pendingTaskCount();
      }
      if (pending > 0) return block(options, state, "legacy queue still has " + pending + " pending task(s)");
      state = advance(options, state, "seed_projection", "running", state.marker);
      continue;
    }
    if (state.phase === "seed_projection") {
      const seeded = await options.next.seed();
      if (seeded.fencedOut === true) return markFencedOut(options, state);
      if (seeded.seedHash.length === 0) return block(options, state, "projection seed did not return a checkpoint hash");
      state = advance(options, state, "shadow_diff", "running", seedMarker(state.marker, seeded.seedHash));
      continue;
    }
    if (state.phase === "shadow_diff") {
      const shadow = await options.next.shadowDiff();
      if (!shadow.matches) return block(options, state, "SQLite shadow diff does not match the frozen Sheet snapshot");
      if (shadow.snapshotHash.length === 0 || shadow.detailHash.length === 0) {
        return block(options, state, "shadow diff did not return durable comparison hashes");
      }
      state = advance(options, state, "mark_cutover", "running", shadowMarker(state.marker, shadow));
      continue;
    }
    if (state.phase === "mark_cutover") {
      const marker = stableHash({
        cutoverId: state.cutoverId,
        sourceSnapshotHash: state.sourceSnapshotHash,
        checkpoints: state.marker,
      });
      state = advance(options, state, "disable_legacy", "running", marker);
      continue;
    }
    if (state.phase === "disable_legacy") {
      await options.legacy.disableWriter();
      state = advance(options, state, "activate_new_writer", "running", state.marker);
      continue;
    }
    if (state.phase === "activate_new_writer") {
      await options.next.activateWriter();
      state = advance(options, state, "complete", "complete", state.marker);
      return state;
    }
    return state;
  }
}

/** Reads an existing cutover checkpoint without starting or mutating an attempt. */
export function readCutoverState(db: DatabaseSyncLike, cutoverId: string): CutoverState | null {
  if (cutoverId.length === 0) throw new Error("cutover ID is required");
  const row = db.prepare(`
    SELECT cutover_id, phase, source_snapshot_hash, marker, status
    FROM cutover_state WHERE cutover_id = ?
  `).get(cutoverId) as CutoverRow | undefined;
  return row === undefined ? null : decodeCutoverRow(row);
}

interface CutoverRow {
  readonly cutover_id: string;
  readonly phase: string;
  readonly source_snapshot_hash: string | null;
  readonly marker: string | null;
  readonly status: string;
}

function loadOrCreateCutover(options: RunCutoverOptions): CutoverState {
  const existing = readCutoverState(options.database, options.cutoverId);
  if (existing !== null) {
    if (existing.sourceSnapshotHash !== options.sourceSnapshotHash) {
      throw new Error("cutover ID was replayed with a different source snapshot hash");
    }
    return existing.status === "blocked"
      ? advance(options, existing, existing.phase, "running", existing.marker)
      : existing;
  }
  if (!isFencingValid(options.database, options.fence)) {
    return {
      cutoverId: options.cutoverId,
      phase: "freeze_legacy",
      sourceSnapshotHash: options.sourceSnapshotHash,
      marker: null,
      status: "fenced_out",
    };
  }
  return withImmediateTransaction(options.database, () => {
    if (!isFencingValid(options.database, options.fence)) {
      return {
        cutoverId: options.cutoverId,
        phase: "freeze_legacy",
        sourceSnapshotHash: options.sourceSnapshotHash,
        marker: null,
        status: "fenced_out" as const,
      };
    }
    const raced = readCutoverState(options.database, options.cutoverId);
    if (raced !== null) {
      if (raced.sourceSnapshotHash !== options.sourceSnapshotHash) {
        throw new Error("cutover ID was replayed with a different source snapshot hash");
      }
      return raced;
    }
    const marker = stableHash({ cutoverId: options.cutoverId, sourceSnapshotHash: options.sourceSnapshotHash });
    options.database.prepare(`
      INSERT INTO cutover_state (
        cutover_id, phase, source_snapshot_hash, marker, status, created_at
      ) VALUES (?, 'freeze_legacy', ?, ?, 'running', ?)
    `).run(options.cutoverId, options.sourceSnapshotHash, marker, options.now);
    return {
      cutoverId: options.cutoverId,
      phase: "freeze_legacy" as const,
      sourceSnapshotHash: options.sourceSnapshotHash,
      marker,
      status: "running" as const,
    };
  });
}

function advance(
  options: RunCutoverOptions,
  current: CutoverState,
  phase: CutoverPhase,
  status: "running" | "blocked" | "complete",
  marker: string | null,
): CutoverState {
  if (!isFencingValid(options.database, options.fence)) return markFencedOut(options, current);
  return withImmediateTransaction(options.database, () => {
    if (!isFencingValid(options.database, options.fence)) return markFencedOut(options, current);
    const result = options.database.prepare(`
      UPDATE cutover_state
      SET phase = ?, marker = ?, status = ?
      WHERE cutover_id = ? AND source_snapshot_hash = ?
    `).run(phase, marker, status, current.cutoverId, current.sourceSnapshotHash);
    if (result.changes !== 1) throw new Error("cutover checkpoint disappeared or source snapshot changed");
    return {
      cutoverId: current.cutoverId,
      phase,
      sourceSnapshotHash: current.sourceSnapshotHash,
      marker,
      status,
    };
  });
}

function block(options: RunCutoverOptions, state: CutoverState, reason: string): CutoverState {
  // The state table intentionally retains no free-form error payload. The
  // caller receives the reason through its own log/alert; marker remains the
  // immutable evidence needed by a restart and restore rehearsal.
  if (reason.length === 0) throw new Error("cutover block reason is required");
  return advance(options, state, state.phase, "blocked", state.marker);
}

function markFencedOut(options: RunCutoverOptions, state: CutoverState): CutoverState {
  if (!isFencingValid(options.database, options.fence)) {
    return { ...state, status: "fenced_out" };
  }
  return advance(options, state, state.phase, "blocked", state.marker);
}

function seedMarker(marker: string | null, seedHash: string): string {
  return stableHash({ priorMarker: marker, seedHash });
}

function shadowMarker(
  marker: string | null,
  shadow: { readonly snapshotHash: string; readonly detailHash: string },
): string {
  return stableHash({ priorMarker: marker, snapshotHash: shadow.snapshotHash, detailHash: shadow.detailHash });
}

function decodeCutoverRow(row: CutoverRow): CutoverState {
  if (row.source_snapshot_hash === null || !isCutoverPhase(row.phase) || !isCutoverStatus(row.status)) {
    throw new Error("stored cutover state is invalid");
  }
  return {
    cutoverId: row.cutover_id,
    phase: row.phase,
    sourceSnapshotHash: row.source_snapshot_hash,
    marker: row.marker,
    status: row.status,
  };
}

function isCutoverPhase(value: string): value is CutoverPhase {
  return value === "freeze_legacy" || value === "drain_legacy" || value === "seed_projection" ||
    value === "shadow_diff" || value === "mark_cutover" || value === "disable_legacy" ||
    value === "activate_new_writer" || value === "complete";
}

function isCutoverStatus(value: string): value is CutoverState["status"] {
  return value === "running" || value === "blocked" || value === "complete" || value === "fenced_out";
}

function validateOptions(options: RunCutoverOptions): void {
  if (options.cutoverId.length === 0 || options.sourceSnapshotHash.length === 0) {
    throw new Error("cutover ID and source snapshot hash are required");
  }
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new Error("cutover time must be a non-negative safe integer");
  }
}
