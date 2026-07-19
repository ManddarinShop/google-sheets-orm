/**
 * Shared contracts for pure batch evaluation.
 *
 * These types keep evaluator inputs and outcomes independent from SQLite,
 * gateway transport, and any repository implementation.
 */

import type { NormalizedCell } from "../encoding/types.js";
import type {
  CanonicalEntityState,
  OwnershipManifest,
  QuarantinePlan,
  RepairPlan,
  RowBindingContext,
  SyncConflict,
} from "../model/types.js";

/** One accepted canonical field write produced by a row evaluation. */
export interface AcceptedField {
  readonly fieldName: string;
  readonly nextValue: NormalizedCell;
  readonly nextFieldRevision: number;
}

/** A field-level stale-write conflict that requires explicit resolution. */
export interface FieldConflict {
  readonly fieldName: string;
  readonly userValue: NormalizedCell;
  readonly userBaseRevision: number;
  readonly canonicalValue: NormalizedCell;
  readonly canonicalRevision: number;
}

/** Terminal classification for one independently evaluated observation row. */
export type RowOutcome = "accepted" | "partially_accepted" | "conflict" | "quarantine";

/** Full immutable decision for one row in an observation batch. */
export interface RowEvaluationResult {
  readonly rowBindingId: string;
  readonly outcome: RowOutcome;
  readonly acceptedFields: readonly AcceptedField[];
  readonly conflicts: readonly FieldConflict[];
  readonly quarantine: QuarantinePlan | null;
  readonly repairPlan: RepairPlan | null;
  readonly nextEntityRevision: number | null;
}

/** Aggregate classification for a row-independent observation batch. */
export type BatchOutcome = "accepted" | "partially_accepted" | "conflict" | "quarantine";

/** Result returned by the pure batch evaluator. */
export interface BatchEvaluationResult {
  readonly batchId: string;
  readonly rowResults: readonly RowEvaluationResult[];
  readonly overallOutcome: BatchOutcome;
}

/** Canonical and active-candidate context supplied by the storage boundary. */
export interface EvaluationContext {
  readonly manifest: OwnershipManifest;
  readonly canonicalByBindingId: ReadonlyMap<string, CanonicalEntityState>;
  readonly bindingByBindingId: ReadonlyMap<string, RowBindingContext>;
  readonly activeConflictsByBindingAndField: ReadonlyMap<string, ReadonlyMap<string, SyncConflict>>;
  /** Active unique keys by manifest field and stable normalized-cell hash. */
  readonly businessKeyEntityIdsByField: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly schemaVersion: number;
}

/** Field identity material that distinguishes ABA and revision attempts. */
export interface EventKeyField {
  readonly fieldName: string;
  readonly baseFieldRevision: number | null;
  readonly candidateEpoch: number;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly nextValue: NormalizedCell;
}
