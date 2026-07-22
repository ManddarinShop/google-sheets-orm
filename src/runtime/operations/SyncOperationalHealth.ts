/**
 * Bounded operational health checks for the SQLite sync runtime.
 *
 * These checks do not retry or mutate effects. They expose backlog/age/failure
 * conditions so a deployer can stop new ingestion before an Apps Script quota
 * or DocumentLock bottleneck becomes an unbounded retry loop.
 */

import type { DatabaseSyncLike } from "../../storage/index.js";

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
  readonly oldestPendingAgeMs: number | null;
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
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_effects,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_effects,
      SUM(CASE WHEN status = 'blocked_candidate' THEN 1 ELSE 0 END) AS blocked_candidate_effects,
      MIN(CASE WHEN status = 'pending' AND created_at > 0 THEN created_at ELSE NULL END) AS oldest_known_pending_at,
      SUM(CASE WHEN status = 'pending' AND created_at = 0 THEN 1 ELSE 0 END) AS pending_with_unknown_age
    FROM sheet_effect_outbox
  `).get() as {
    pending_effects: number | null;
    failed_effects: number | null;
    blocked_candidate_effects: number | null;
    oldest_known_pending_at: number | null;
    pending_with_unknown_age: number | null;
  };
  const pendingEffects = totals.pending_effects ?? 0;
  const failedEffects = totals.failed_effects ?? 0;
  const blockedCandidateEffects = totals.blocked_candidate_effects ?? 0;
  const oldestPendingAgeMs = totals.oldest_known_pending_at === null
    ? null
    : Math.max(0, now - totals.oldest_known_pending_at);
  const alerts: SyncOperationalAlert[] = [];
  if (pendingEffects > limits.maxPendingEffects) {
    alerts.push({ code: "outbox_pending_backpressure", count: pendingEffects, threshold: limits.maxPendingEffects });
  }
  if (oldestPendingAgeMs !== null && oldestPendingAgeMs > limits.maxPendingAgeMs) {
    alerts.push({ code: "outbox_pending_age", count: oldestPendingAgeMs, threshold: limits.maxPendingAgeMs });
  }
  if ((totals.pending_with_unknown_age ?? 0) > 0) {
    alerts.push({
      code: "outbox_pending_age_unknown",
      count: totals.pending_with_unknown_age ?? 0,
      threshold: 0,
    });
  }
  if (failedEffects > limits.maxFailedEffects) {
    alerts.push({ code: "outbox_failed", count: failedEffects, threshold: limits.maxFailedEffects });
  }
  if (blockedCandidateEffects > limits.maxBlockedCandidates) {
    alerts.push({
      code: "candidate_blocked", count: blockedCandidateEffects, threshold: limits.maxBlockedCandidates });
  }
  return {
    pendingEffects,
    failedEffects,
    blockedCandidateEffects,
    oldestPendingAgeMs,
    alerts,
    backpressure: alerts.some((alert) =>
      alert.code === "outbox_pending_backpressure" || alert.code === "outbox_pending_age" ||
      alert.code === "outbox_pending_age_unknown",
    ),
  };
}

function validateLimits(limits: SyncOperationalLimits, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("health sample time must be non-negative");
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(name + " must be a non-negative safe integer");
    }
  }
}
