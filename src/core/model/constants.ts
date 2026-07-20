/** Runtime values for canonical conflict lifecycle states. */
export const CONFLICT_STATUSES = {
  OPEN: "OPEN",
  NEEDS_REBASE: "NEEDS_REBASE",
  RESOLVED: "RESOLVED",
} as const;

/** Closed set of canonical conflict lifecycle states. */
export type ConflictStatus =
  (typeof CONFLICT_STATUSES)[keyof typeof CONFLICT_STATUSES];
