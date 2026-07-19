/**
 * Contracts shared by the durable observation writer modules.
 *
 * The input is already normalized and evaluated by pure core. Storage owns
 * only idempotent receipts, canonical commits, conflict records, and effects.
 */

import type {
  EditorActorSource,
  FieldConflict,
  ObservedEditBatch,
  ObservedRowChange,
  QuarantinePlan,
  RowEvaluationResult,
} from "../../core/index.js";
import type { CanonicalCommitInput, CanonicalCommitResult } from "./canonicalCommit.js";
import type { NewEffect } from "../sync/effectOutbox.js";

/** One append-only occurrence captured by a gateway or polling adapter. */
export interface ObservationAttemptInput {
  readonly observationId: string;
  readonly observationKey: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly detectedAt: number;
  readonly receivedAt: number;
  readonly ingressActorId: string;
  readonly editorActorId: string | null;
  readonly editorActorSource: EditorActorSource;
}

/** Event identity computed after observation identity resolution. */
export interface EventIdentityInput {
  readonly eventKey: string;
  readonly payloadHash: string;
}

/** One active unique-key change that must commit with canonical state. */
export interface BusinessKeyChange {
  readonly fieldName: string;
  readonly previousNormalizedKey: string | null;
  readonly nextNormalizedKey: string | null;
}

/** Canonical mutation and key claims committed in the same writer transaction. */
export interface CanonicalRowMutation {
  readonly commitId: string;
  readonly commit: CanonicalCommitInput;
  readonly businessKeyChanges: readonly BusinessKeyChange[];
}

/** Input for exactly one row of an observed batch. */
export interface PersistObservedRowInput {
  readonly physicalSheetId: string;
  readonly batch: ObservedEditBatch;
  readonly rowIndex: number;
  readonly observation: ObservationAttemptInput;
  readonly event: EventIdentityInput | null;
  readonly evaluation: RowEvaluationResult;
  readonly canonical: CanonicalRowMutation | null;
  readonly effects: readonly NewEffect[];
}

/** Durable outcome for one row-independent observation submission. */
export type PersistObservedRowResult =
  | { readonly kind: "fenced_out" }
  | { readonly kind: "stale" }
  | {
      readonly kind: "duplicate";
      readonly observationId: string;
      readonly eventId: string | null;
      readonly reason: "observation" | "event" | "candidate";
    }
  | {
      readonly kind: "quarantined";
      readonly observationId: string;
      readonly eventId: string | null;
      readonly quarantineId: string;
    }
  | {
      readonly kind: "persisted";
      readonly observationId: string;
      readonly eventId: string;
      readonly eventSequence: number;
      readonly outcome: "accepted" | "partially_accepted" | "conflict";
      readonly entityRevision: number | null;
      readonly conflictIds: readonly string[];
    };

export interface ReceiptRow {
  readonly representative_payload_hash: string;
  readonly event_id: string | null;
  readonly state: "pending" | "evaluated" | "duplicate" | "quarantined";
}

export interface EventRow {
  readonly event_id: string;
  readonly payload_hash: string;
  readonly event_sequence: number;
}

export interface RowBindingRow {
  readonly entity_id: string | null;
  readonly state: "candidate" | "active" | "tombstoned" | "ambiguous";
}

export interface ActiveCandidateRow {
  readonly active_candidate_conflict_id: string;
  readonly active_candidate_hash: string;
  readonly candidate_epoch: number;
  readonly event_id: string;
  readonly status: "OPEN" | "NEEDS_REBASE" | "RESOLVED";
}

export interface CreatedEvent {
  readonly eventId: string;
  readonly eventSequence: number;
}

export interface ObservationAppendResult {
  readonly kind: "new" | "pending_replay" | "duplicate" | "integrity_collision";
  readonly eventId: string | null;
}

/** Signals that the writer lease changed inside an outer transaction. */
export class FenceLostError extends Error {}

/** Signals that a canonical CAS/binding transition became stale. */
export class CanonicalStaleError extends Error {}

/** Input type retained here for conflict-ledger helpers. */
export type ObservationConflict = FieldConflict;

/** Input type retained here for quarantine-ledger helpers. */
export type ObservationQuarantine = QuarantinePlan;

/** Applied canonical result used by canonical/conflict composition. */
export type AppliedCanonicalCommit = Extract<CanonicalCommitResult, { readonly kind: "applied" }>;

/** The observed row type is re-exported for storage-private helper signatures. */
export type ObservationRow = ObservedRowChange;
