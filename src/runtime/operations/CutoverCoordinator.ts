/**
 * Restart-safe migration/cutover coordinator.
 *
 * The old queue remains the only writer until every persisted gate has passed.
 * External queue operations are deliberately small/idempotent interfaces so a
 * process crash between an external call and SQLite checkpoint can safely run
 * the same phase again without enabling dual writers.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type LookupResult,
  type Presence,
} from "../../core/index.js";
import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../core/state/constants.js";
import {
  isFencingValid,
  withImmediateTransaction,
  type DatabaseSyncLike,
  type FencingContext,
} from "../../storage/index.js";
import { EXPECTED_SINGLE_ROW_CHANGE_COUNT } from "../../storage/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../storage/errors.js";
import { fromSqlNullable, toSqlNullable } from "../../storage/sqlite/sqlState.js";

const CUTOVER_PHASES = {
  FREEZE_LEGACY: "freeze_legacy",
  DRAIN_LEGACY: "drain_legacy",
  SEED_PROJECTION: "seed_projection",
  SHADOW_DIFF: "shadow_diff",
  MARK_CUTOVER: "mark_cutover",
  DISABLE_LEGACY: "disable_legacy",
  ACTIVATE_NEW_WRITER: "activate_new_writer",
  COMPLETE: "complete",
} as const satisfies Record<string, CutoverPhase>;

const CUTOVER_STATUSES = {
  RUNNING: "running",
  BLOCKED: "blocked",
  COMPLETE: "complete",
  FENCED_OUT: "fenced_out",
} as const satisfies Record<string, CutoverState["status"]>;

const READ_CUTOVER_STATE_SQL = `
  SELECT cutover_id, phase, source_snapshot_hash, marker, status
  FROM cutover_state
  WHERE cutover_id = ?
`;

const INSERT_CUTOVER_STATE_SQL = `
  INSERT INTO cutover_state (
    cutover_id, phase, source_snapshot_hash, marker, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const UPDATE_CUTOVER_STATE_SQL = `
  UPDATE cutover_state
  SET phase = ?, marker = ?, status = ?
  WHERE cutover_id = ? AND source_snapshot_hash = ?
`;

const ABSENT_MARKER: Presence<string> = { kind: PRESENCE_KINDS.ABSENT };

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
  readonly marker: Presence<string>;
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
  if (state.status === CUTOVER_STATUSES.FENCED_OUT || state.phase === CUTOVER_PHASES.COMPLETE) return state;

  while (true) {
    if (!isFencingValid(options.database, options.fence)) {
      return markFencedOut(options, state);
    }
    if (state.phase === CUTOVER_PHASES.FREEZE_LEGACY) {
      const frozen = await options.legacy.freezeWrites();
      if (frozen.sourceSnapshotHash !== options.sourceSnapshotHash) {
        return block(options, state, "legacy freeze snapshot does not match requested cutover source");
      }
      state = advance(options, state, CUTOVER_PHASES.DRAIN_LEGACY, CUTOVER_STATUSES.RUNNING, state.marker);
      continue;
    }
    if (state.phase === CUTOVER_PHASES.DRAIN_LEGACY) {
      let pending = await options.legacy.pendingTaskCount();
      if (pending > NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
        await options.legacy.drainPendingTasks();
        pending = await options.legacy.pendingTaskCount();
      }
      if (pending > NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
        return block(options, state, "legacy queue still has " + pending + " pending task(s)");
      }
      state = advance(options, state, CUTOVER_PHASES.SEED_PROJECTION, CUTOVER_STATUSES.RUNNING, state.marker);
      continue;
    }
    if (state.phase === CUTOVER_PHASES.SEED_PROJECTION) {
      const seeded = await options.next.seed();
      if (seeded.fencedOut === true) return markFencedOut(options, state);
      if (seeded.seedHash.length === EMPTY_STRING_LENGTH_ZERO) {
        return block(options, state, "projection seed did not return a checkpoint hash");
      }
      state = advance(
        options,
        state,
        CUTOVER_PHASES.SHADOW_DIFF,
        CUTOVER_STATUSES.RUNNING,
        seedMarker(state.marker, seeded.seedHash),
      );
      continue;
    }
    if (state.phase === CUTOVER_PHASES.SHADOW_DIFF) {
      const shadow = await options.next.shadowDiff();
      if (!shadow.matches) return block(options, state, "SQLite shadow diff does not match the frozen Sheet snapshot");
      if (
        shadow.snapshotHash.length === EMPTY_STRING_LENGTH_ZERO ||
        shadow.detailHash.length === EMPTY_STRING_LENGTH_ZERO
      ) {
        return block(options, state, "shadow diff did not return durable comparison hashes");
      }
      state = advance(
        options,
        state,
        CUTOVER_PHASES.MARK_CUTOVER,
        CUTOVER_STATUSES.RUNNING,
        shadowMarker(state.marker, shadow),
      );
      continue;
    }
    if (state.phase === CUTOVER_PHASES.MARK_CUTOVER) {
      const marker = stableHash({
        cutoverId: state.cutoverId,
        sourceSnapshotHash: state.sourceSnapshotHash,
        checkpoints: toSqlNullable(state.marker),
      });
      state = advance(
        options,
        state,
        CUTOVER_PHASES.DISABLE_LEGACY,
        CUTOVER_STATUSES.RUNNING,
        { kind: PRESENCE_KINDS.PRESENT, value: marker },
      );
      continue;
    }
    if (state.phase === CUTOVER_PHASES.DISABLE_LEGACY) {
      await options.legacy.disableWriter();
      state = advance(
        options,
        state,
        CUTOVER_PHASES.ACTIVATE_NEW_WRITER,
        CUTOVER_STATUSES.RUNNING,
        state.marker,
      );
      continue;
    }
    if (state.phase === CUTOVER_PHASES.ACTIVATE_NEW_WRITER) {
      await options.next.activateWriter();
      state = advance(options, state, CUTOVER_PHASES.COMPLETE, CUTOVER_STATUSES.COMPLETE, state.marker);
      return state;
    }
    return state;
  }
}

/** Reads an existing cutover checkpoint without starting or mutating an attempt. */
export function readCutoverState(db: DatabaseSyncLike, cutoverId: string): LookupResult<CutoverState> {
  if (cutoverId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new StorageError(STORAGE_ERROR_CODES.INVALID_CUTOVER_OPTIONS, "cutover ID is required");
  }
  const row = db.prepare(READ_CUTOVER_STATE_SQL).get<CutoverRow>(cutoverId);
  return row === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value: decodeCutoverRow(row) };
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
  if (existing.kind === LOOKUP_RESULT_KINDS.FOUND) {
    if (existing.value.sourceSnapshotHash !== options.sourceSnapshotHash) {
      throw new StorageError(
        STORAGE_ERROR_CODES.CUTOVER_IDENTITY_CONFLICT,
        "cutover ID was replayed with a different source snapshot hash",
      );
    }
    return existing.value.status === CUTOVER_STATUSES.BLOCKED
      ? advance(options, existing.value, existing.value.phase, CUTOVER_STATUSES.RUNNING, existing.value.marker)
      : existing.value;
  }
  if (!isFencingValid(options.database, options.fence)) {
    return {
      cutoverId: options.cutoverId,
      phase: CUTOVER_PHASES.FREEZE_LEGACY,
      sourceSnapshotHash: options.sourceSnapshotHash,
      marker: ABSENT_MARKER,
      status: CUTOVER_STATUSES.FENCED_OUT,
    };
  }
  return withImmediateTransaction(options.database, () => {
    if (!isFencingValid(options.database, options.fence)) {
      return {
        cutoverId: options.cutoverId,
        phase: CUTOVER_PHASES.FREEZE_LEGACY,
        sourceSnapshotHash: options.sourceSnapshotHash,
        marker: ABSENT_MARKER,
        status: CUTOVER_STATUSES.FENCED_OUT,
      };
    }
    const raced = readCutoverState(options.database, options.cutoverId);
    if (raced.kind === LOOKUP_RESULT_KINDS.FOUND) {
      if (raced.value.sourceSnapshotHash !== options.sourceSnapshotHash) {
        throw new StorageError(
          STORAGE_ERROR_CODES.CUTOVER_IDENTITY_CONFLICT,
          "cutover ID was replayed with a different source snapshot hash",
        );
      }
      return raced.value;
    }
    const marker = stableHash({ cutoverId: options.cutoverId, sourceSnapshotHash: options.sourceSnapshotHash });
    options.database.prepare(INSERT_CUTOVER_STATE_SQL).run(
      options.cutoverId,
      CUTOVER_PHASES.FREEZE_LEGACY,
      options.sourceSnapshotHash,
      marker,
      CUTOVER_STATUSES.RUNNING,
      options.now,
    );
    return {
      cutoverId: options.cutoverId,
      phase: CUTOVER_PHASES.FREEZE_LEGACY,
      sourceSnapshotHash: options.sourceSnapshotHash,
      marker: { kind: PRESENCE_KINDS.PRESENT, value: marker },
      status: CUTOVER_STATUSES.RUNNING,
    };
  });
}

function advance(
  options: RunCutoverOptions,
  current: CutoverState,
  phase: CutoverPhase,
  status: "running" | "blocked" | "complete",
  marker: Presence<string>,
): CutoverState {
  if (!isFencingValid(options.database, options.fence)) return markFencedOut(options, current);
  return withImmediateTransaction(options.database, () => {
    if (!isFencingValid(options.database, options.fence)) return markFencedOut(options, current);
    const result = options.database.prepare(UPDATE_CUTOVER_STATE_SQL).run(
      phase,
      toSqlNullable(marker),
      status,
      current.cutoverId,
      current.sourceSnapshotHash,
    );
    if (result.changes !== EXPECTED_SINGLE_ROW_CHANGE_COUNT) {
      throw new StorageError(
        STORAGE_ERROR_CODES.CUTOVER_CHECKPOINT_FAILED,
        "cutover checkpoint disappeared or source snapshot changed",
      );
    }
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
  if (reason.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new StorageError(STORAGE_ERROR_CODES.CUTOVER_STATE_INVALID, "cutover block reason is required");
  }
  return advance(options, state, state.phase, CUTOVER_STATUSES.BLOCKED, state.marker);
}

function markFencedOut(options: RunCutoverOptions, state: CutoverState): CutoverState {
  if (!isFencingValid(options.database, options.fence)) {
    return { ...state, status: CUTOVER_STATUSES.FENCED_OUT };
  }
  return advance(options, state, state.phase, CUTOVER_STATUSES.BLOCKED, state.marker);
}

function seedMarker(marker: Presence<string>, seedHash: string): Presence<string> {
  return {
    kind: PRESENCE_KINDS.PRESENT,
    value: stableHash({ priorMarker: toSqlNullable(marker), seedHash }),
  };
}

function shadowMarker(
  marker: Presence<string>,
  shadow: { readonly snapshotHash: string; readonly detailHash: string },
): Presence<string> {
  return {
    kind: PRESENCE_KINDS.PRESENT,
    value: stableHash({
      priorMarker: toSqlNullable(marker),
      snapshotHash: shadow.snapshotHash,
      detailHash: shadow.detailHash,
    }),
  };
}

function decodeCutoverRow(row: CutoverRow): CutoverState {
  const sourceSnapshotHash = fromSqlNullable(row.source_snapshot_hash);
  if (
    sourceSnapshotHash.kind !== PRESENCE_KINDS.PRESENT ||
    !isCutoverPhase(row.phase) ||
    !isCutoverStatus(row.status)
  ) {
    throw new StorageError(STORAGE_ERROR_CODES.CUTOVER_STATE_INVALID, "stored cutover state is invalid");
  }
  return {
    cutoverId: row.cutover_id,
    phase: row.phase,
    sourceSnapshotHash: sourceSnapshotHash.value,
    marker: fromSqlNullable(row.marker),
    status: row.status,
  };
}

function isCutoverPhase(value: string): value is CutoverPhase {
  return value === CUTOVER_PHASES.FREEZE_LEGACY ||
    value === CUTOVER_PHASES.DRAIN_LEGACY ||
    value === CUTOVER_PHASES.SEED_PROJECTION ||
    value === CUTOVER_PHASES.SHADOW_DIFF ||
    value === CUTOVER_PHASES.MARK_CUTOVER ||
    value === CUTOVER_PHASES.DISABLE_LEGACY ||
    value === CUTOVER_PHASES.ACTIVATE_NEW_WRITER ||
    value === CUTOVER_PHASES.COMPLETE;
}

function isCutoverStatus(value: string): value is CutoverState["status"] {
  return value === CUTOVER_STATUSES.RUNNING ||
    value === CUTOVER_STATUSES.BLOCKED ||
    value === CUTOVER_STATUSES.COMPLETE ||
    value === CUTOVER_STATUSES.FENCED_OUT;
}

function validateOptions(options: RunCutoverOptions): void {
  if (
    options.cutoverId.length === EMPTY_STRING_LENGTH_ZERO ||
    options.sourceSnapshotHash.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_CUTOVER_OPTIONS,
      "cutover ID and source snapshot hash are required",
    );
  }
  if (!Number.isSafeInteger(options.now) || options.now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_CUTOVER_OPTIONS,
      "cutover time must be a non-negative safe integer",
    );
  }
}
