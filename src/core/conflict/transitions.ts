/**
 * Conflict lifecycle transitions.
 *
 * Per design: conflict status is OPEN, NEEDS_REBASE, RESOLVED only.
 * SUPERSEDED is not a conflict status.
 *
 * - OPEN: initial state when a stale field is detected
 * - NEEDS_REBASE: same field's canonical value advanced while conflict is open
 * - RESOLVED: user submitted acknowledge_system with matching revision/hash CAS
 */

import { stableHash } from "../encoding/stableEncode.js";
import type { NormalizedCell } from "../encoding/types.js";
import type { ConflictStatus, ResolutionCommand, SyncConflict } from "../model/types.js";

/** Result of attempting to transition a conflict via a resolution command. */
export type ConflictTransitionResult =
  | { readonly kind: "resolved"; readonly conflict: SyncConflict }
  | { readonly kind: "stale"; readonly conflict: SyncConflict }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Determines whether a canonical commit should trigger NEEDS_REBASE.
 *
 * Called within the same SQLite transaction that commits the canonical change.
 * If the same field has an OPEN or NEEDS_REBASE conflict, the conflict's
 * current canonical projection is updated and status set to NEEDS_REBASE.
 */
export function shouldRebaseConflict(
  conflict: SyncConflict,
  changedFieldName: string,
  newCanonicalRevision: number,
  newCanonicalValue: NormalizedCell,
): SyncConflict | null {
  if (conflict.fieldName !== changedFieldName) return null;
  if (conflict.status === "RESOLVED") return null;
  if (newCanonicalRevision <= conflict.currentCanonicalRevision) return null;

  return {
    ...conflict,
    currentCanonicalValue: newCanonicalValue,
    currentCanonicalRevision: newCanonicalRevision,
    status: "NEEDS_REBASE",
  };
}

/**
 * Applies a resolution command to a conflict via compare-and-set.
 *
 * The command's expected revision, active candidate hash, and candidate epoch
 * must match the conflict's current state. The epoch prevents an old request
 * from resolving an ABA retry that returned to the same candidate value. If
 * any CAS input does not match, the conflict stays at its current status
 * (NEEDS_REBASE if canonical has advanced) and the checkbox is reset.
 */
export function applyResolution(
  conflict: SyncConflict,
  command: ResolutionCommand,
): ConflictTransitionResult {
  if (command.action !== "acknowledge_system") {
    return { kind: "rejected", reason: `unsupported action: ${command.action}` };
  }

  if (command.role !== "sheet_editor") {
    return { kind: "rejected", reason: "acknowledge_system requires sheet_editor role" };
  }

  if (command.targetConflictId !== conflict.conflictId) {
    return { kind: "rejected", reason: "conflict_id mismatch" };
  }

  if (conflict.status === "RESOLVED") {
    return conflict.resolutionCommandId === command.commandId
      ? { kind: "resolved", conflict }
      : { kind: "rejected", reason: "conflict is already resolved" };
  }

  const revisionMatches = command.expectedRevision === conflict.currentCanonicalRevision;
  const hashMatches = command.activeCandidateHash === candidateHash(conflict);
  const epochMatches = command.expectedCandidateEpoch === conflict.candidateEpoch;

  if (!revisionMatches || !hashMatches || !epochMatches) {
    return {
      kind: "stale",
      conflict:
        conflict.status === "OPEN"
          ? { ...conflict, status: "NEEDS_REBASE" as ConflictStatus }
          : conflict,
    };
  }

  return {
    kind: "resolved",
    conflict: {
      ...conflict,
      status: "RESOLVED" as ConflictStatus,
      resolutionCommandId: command.commandId,
    },
  };
}

/** Computes the active candidate hash for CAS comparison. */
function candidateHash(conflict: SyncConflict): string {
  return stableHash({
    value: conflict.userValue,
    revision: conflict.userBaseRevision,
  });
}
