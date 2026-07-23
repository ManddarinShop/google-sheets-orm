/**
 * Bounded operational health checks for the SQLite sync runtime.
 *
 * These checks do not retry or mutate effects. They expose backlog/age/failure
 * conditions so a deployer can stop new ingestion before an Apps Script quota
 * or DocumentLock bottleneck becomes an unbounded retry loop.
 */

import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  type EffectStatus,
  type Presence,
} from "../../core/index.js";
import { PRESENCE_KINDS } from "../../core/state/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../storage/errors.js";
import type { DatabaseSyncLike } from "../../storage/index.js";
import { fromSqlNullable } from "../../storage/sqlite/sqlState.js";

const OUTBOX_EFFECT_STATUSES = {
  PENDING: "pending",
  FAILED: "failed",
  BLOCKED_CANDIDATE: "blocked_candidate",
} as const satisfies Record<string, EffectStatus>;

const SYNC_OPERATIONAL_ALERT_CODES = {
  PENDING_BACKPRESSURE: "outbox_pending_backpressure",
  PENDING_AGE: "outbox_pending_age",
  PENDING_AGE_UNKNOWN: "outbox_pending_age_unknown",
  FAILED: "outbox_failed",
  CANDIDATE_BLOCKED: "candidate_blocked",
} as const satisfies Record<string, SyncOperationalAlert["code"]>;

const READ_SYNC_OPERATIONAL_TOTALS_SQL = `
  SELECT
    SUM(CASE WHEN status = '${OUTBOX_EFFECT_STATUSES.PENDING}' THEN 1 ELSE 0 END) AS pending_effects,
    SUM(CASE WHEN status = '${OUTBOX_EFFECT_STATUSES.FAILED}' THEN 1 ELSE 0 END) AS failed_effects,
    SUM(CASE WHEN status = '${OUTBOX_EFFECT_STATUSES.BLOCKED_CANDIDATE}' THEN 1 ELSE 0 END) AS blocked_candidate_effects,
    MIN(CASE WHEN status = '${OUTBOX_EFFECT_STATUSES.PENDING}' AND created_at > ${NON_NEGATIVE_SAFE_INTEGER_MINIMUM} THEN created_at ELSE NULL END) AS oldest_known_pending_at,
    SUM(CASE WHEN status = '${OUTBOX_EFFECT_STATUSES.PENDING}' AND created_at = ${NON_NEGATIVE_SAFE_INTEGER_MINIMUM} THEN 1 ELSE 0 END) AS pending_with_unknown_age
  FROM sheet_effect_outbox
`;

/** Deployment-specific ceilings for one health sample. */
export interface SyncOperationalLimits {
  readonly maxPendingEffects: number;
  readonly maxPendingAgeMs: number;
  readonly maxFailedEffects: number;
  readonly maxBlockedCandidates: number;
}

/** Machine-readable alert emitted when a limit is breached or legacy age is unknown. */
export interface SyncOperationalAlert {
  readonly code:
    | "outbox_pending_backpressure"
    | "outbox_pending_age"
    | "outbox_pending_age_unknown"
    | "outbox_failed"
    | "candidate_blocked";
  readonly count: number;
  readonly threshold: number;
}

/** Read-only operational health sample. */
export interface SyncOperationalHealth {
  readonly pendingEffects: number;
  readonly failedEffects: number;
  readonly blockedCandidateEffects: number;
  readonly oldestPendingAgeMs: Presence<number>;
  readonly alerts: readonly SyncOperationalAlert[];
  readonly backpressure: boolean;
}

/**
 * Collects bounded outbox health from durable state without changing retry status.
 *
 * `created_at = 0` means a pre-v3 legacy effect whose age cannot be proven; it
 * triggers an explicit unknown-age alert rather than fabricating an age.
 */
export function collectSyncOperationalHealth(
  db: DatabaseSyncLike,
  limits: SyncOperationalLimits,
  now: number,
): SyncOperationalHealth {
  validateLimits(limits, now);
  const totals = db.prepare(READ_SYNC_OPERATIONAL_TOTALS_SQL).get<{
    pending_effects: number | null;
    failed_effects: number | null;
    blocked_candidate_effects: number | null;
    oldest_known_pending_at: number | null;
    pending_with_unknown_age: number | null;
  }>();
  if (totals === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_OPERATIONAL_HEALTH_UNAVAILABLE,
      "could not read sync operational health totals",
    );
  }
  const pendingEffects = aggregateCount(totals.pending_effects);
  const failedEffects = aggregateCount(totals.failed_effects);
  const blockedCandidateEffects = aggregateCount(totals.blocked_candidate_effects);
  const oldestKnownPendingAt = fromSqlNullable(totals.oldest_known_pending_at);
  const oldestPendingAgeMs: Presence<number> = oldestKnownPendingAt.kind === PRESENCE_KINDS.ABSENT
    ? { kind: PRESENCE_KINDS.ABSENT }
    : {
      kind: PRESENCE_KINDS.PRESENT,
      value: Math.max(NON_NEGATIVE_SAFE_INTEGER_MINIMUM, now - oldestKnownPendingAt.value),
    };
  const pendingWithUnknownAge = aggregateCount(totals.pending_with_unknown_age);
  const alerts: SyncOperationalAlert[] = [];
  if (pendingEffects > limits.maxPendingEffects) {
    alerts.push({
      code: SYNC_OPERATIONAL_ALERT_CODES.PENDING_BACKPRESSURE,
      count: pendingEffects,
      threshold: limits.maxPendingEffects,
    });
  }
  if (
    oldestPendingAgeMs.kind === PRESENCE_KINDS.PRESENT &&
    oldestPendingAgeMs.value > limits.maxPendingAgeMs
  ) {
    alerts.push({
      code: SYNC_OPERATIONAL_ALERT_CODES.PENDING_AGE,
      count: oldestPendingAgeMs.value,
      threshold: limits.maxPendingAgeMs,
    });
  }
  if (pendingWithUnknownAge > NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
    alerts.push({
      code: SYNC_OPERATIONAL_ALERT_CODES.PENDING_AGE_UNKNOWN,
      count: pendingWithUnknownAge,
      threshold: NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
    });
  }
  if (failedEffects > limits.maxFailedEffects) {
    alerts.push({
      code: SYNC_OPERATIONAL_ALERT_CODES.FAILED,
      count: failedEffects,
      threshold: limits.maxFailedEffects,
    });
  }
  if (blockedCandidateEffects > limits.maxBlockedCandidates) {
    alerts.push({
      code: SYNC_OPERATIONAL_ALERT_CODES.CANDIDATE_BLOCKED,
      count: blockedCandidateEffects,
      threshold: limits.maxBlockedCandidates,
    });
  }
  return {
    pendingEffects,
    failedEffects,
    blockedCandidateEffects,
    oldestPendingAgeMs,
    alerts,
    backpressure: alerts.some((alert) =>
      alert.code === SYNC_OPERATIONAL_ALERT_CODES.PENDING_BACKPRESSURE ||
      alert.code === SYNC_OPERATIONAL_ALERT_CODES.PENDING_AGE ||
      alert.code === SYNC_OPERATIONAL_ALERT_CODES.PENDING_AGE_UNKNOWN,
    ),
  };
}

function validateLimits(limits: SyncOperationalLimits, now: number): void {
  if (!Number.isSafeInteger(now) || now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_OPERATIONAL_LIMITS,
      "health sample time must be non-negative",
    );
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_SYNC_OPERATIONAL_LIMITS,
        name + " must be a non-negative safe integer",
      );
    }
  }
}

function aggregateCount(value: number | null): number {
  const state = fromSqlNullable(value);
  return state.kind === PRESENCE_KINDS.PRESENT
    ? state.value
    : NON_NEGATIVE_SAFE_INTEGER_MINIMUM;
}
