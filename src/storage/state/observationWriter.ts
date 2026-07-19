/**
 * Fenced observation-to-storage composer for the SQLite-authoritative phase.
 *
 * It persists one already-normalized, already-evaluated row per immediate
 * transaction. The focused modules it calls own validation, receipt/event
 * ledgering, canonical state, conflicts, and quarantine evidence.
 */

import { appendPendingEffects } from "../sync/effectOutbox.js";
import { withImmediateTransaction, type DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { isFencingValid, type FencingContext } from "../sync/writerLease.js";
import {
  applyCanonicalMutation,
  persistConflictAttempts,
  requirePersistedOutcome,
} from "./observationCanonical.js";
import {
  appendObservation,
  completeObservation,
  createEvent,
  findEventByKey,
  findMatchingCandidateEventId,
  persistObservedHashes,
  requireKnownBinding,
} from "./observationLedger.js";
import { persistIntegrityQuarantine, persistQuarantine } from "./observationQuarantine.js";
import {
  CanonicalStaleError,
  FenceLostError,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "./observationTypes.js";
import {
  ensureEffectsTargetRegistered,
  ensureRegisteredProjection,
  requireBatchRow,
  validatePersistObservedRowInput,
} from "./observationValidation.js";

export type {
  ObservationAttemptInput,
  EventIdentityInput,
  BusinessKeyChange,
  CanonicalRowMutation,
  PersistObservedRowInput,
  PersistObservedRowResult,
} from "./observationTypes.js";

/**
 * Persists one normalized row outcome at the writer-RPC boundary.
 *
 * No Sheet call is made here. A stale fence or canonical CAS rolls back the
 * whole transaction so the adapter can re-read and submit again.
 */
export function persistObservedRow(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistObservedRowInput,
): PersistObservedRowResult {
  validatePersistObservedRowInput(input);
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };

  try {
    return withImmediateTransaction(db, () => {
      assertCurrentFence(db, fence);
      const row = requireBatchRow(input.batch, input.rowIndex);
      ensureRegisteredProjection(db, input.batch, input.physicalSheetId);
      ensureEffectsTargetRegistered(db, input.batch.sheetId, input.effects);
      if (input.canonical !== null) {
        ensureEffectsTargetRegistered(db, input.batch.sheetId, input.canonical.commit.effects);
      }

      const observation = appendObservation(
        db,
        input.batch,
        input.physicalSheetId,
        input.observation,
      );
      if (observation.kind === "duplicate") {
        return {
          kind: "duplicate",
          observationId: input.observation.observationId,
          eventId: observation.eventId,
          reason: "observation",
        };
      }
      if (observation.kind === "integrity_collision") {
        const quarantineId = persistIntegrityQuarantine(
          db,
          input,
          row,
          null,
          "observation_key_payload_mismatch",
        );
        completeObservation(db, input.batch.sheetId, input.observation, null, "quarantined");
        return {
          kind: "quarantined",
          observationId: input.observation.observationId,
          eventId: null,
          quarantineId,
        };
      }

      if (input.event === null) {
        const quarantine = input.evaluation.quarantine;
        if (quarantine === null) {
          throw new Error("an unresolved observation must have a core quarantine plan");
        }
        const quarantineId = persistQuarantine(db, input, quarantine, null);
        appendAdditionalEffectsOrThrow(db, fence, input.effects);
        completeObservation(db, input.batch.sheetId, input.observation, null, "quarantined");
        return {
          kind: "quarantined",
          observationId: input.observation.observationId,
          eventId: null,
          quarantineId,
        };
      }

      const binding = requireKnownBinding(db, input.batch.sheetId, row.rowBindingId);
      const matchingCandidateEventId = findMatchingCandidateEventId(db, input, row, binding);
      if (matchingCandidateEventId !== null) {
        completeObservation(
          db,
          input.batch.sheetId,
          input.observation,
          matchingCandidateEventId,
          "duplicate",
        );
        return {
          kind: "duplicate",
          observationId: input.observation.observationId,
          eventId: matchingCandidateEventId,
          reason: "candidate",
        };
      }

      const existingEvent = findEventByKey(db, input.batch.sheetId, input.event.eventKey);
      if (existingEvent !== null) {
        if (existingEvent.payload_hash === input.event.payloadHash) {
          completeObservation(
            db,
            input.batch.sheetId,
            input.observation,
            existingEvent.event_id,
            "duplicate",
          );
          return {
            kind: "duplicate",
            observationId: input.observation.observationId,
            eventId: existingEvent.event_id,
            reason: "event",
          };
        }

        const quarantineId = persistIntegrityQuarantine(
          db,
          input,
          row,
          null,
          "event_key_payload_mismatch",
        );
        completeObservation(db, input.batch.sheetId, input.observation, null, "quarantined");
        return {
          kind: "quarantined",
          observationId: input.observation.observationId,
          eventId: null,
          quarantineId,
        };
      }

      const createdEvent = createEvent(db, input, row);
      persistObservedHashes(db, input, row);

      if (input.evaluation.quarantine !== null) {
        const quarantineId = persistQuarantine(
          db,
          input,
          input.evaluation.quarantine,
          createdEvent.eventId,
        );
        appendAdditionalEffectsOrThrow(db, fence, input.effects);
        completeObservation(
          db,
          input.batch.sheetId,
          input.observation,
          createdEvent.eventId,
          "quarantined",
        );
        return {
          kind: "quarantined",
          observationId: input.observation.observationId,
          eventId: createdEvent.eventId,
          quarantineId,
        };
      }

      const canonicalResult = applyCanonicalMutation(db, fence, input, row, binding);
      const conflictIds = persistConflictAttempts(db, input, row, binding, createdEvent.eventId);
      appendAdditionalEffectsOrThrow(db, fence, input.effects);

      const eventStatus = input.evaluation.conflicts.length === 0 ? "accepted" : "conflict";
      db.prepare("UPDATE event_log SET status = ? WHERE event_id = ?")
        .run(eventStatus, createdEvent.eventId);
      completeObservation(
        db,
        input.batch.sheetId,
        input.observation,
        createdEvent.eventId,
        "evaluated",
      );

      return {
        kind: "persisted",
        observationId: input.observation.observationId,
        eventId: createdEvent.eventId,
        eventSequence: createdEvent.eventSequence,
        outcome: requirePersistedOutcome(input.evaluation),
        entityRevision: canonicalResult?.entityRevision ?? null,
        conflictIds,
      };
    });
  } catch (error: unknown) {
    if (error instanceof FenceLostError) return { kind: "fenced_out" };
    if (error instanceof CanonicalStaleError) return { kind: "stale" };
    throw error;
  }
}

function appendAdditionalEffectsOrThrow(
  db: DatabaseSyncLike,
  fence: FencingContext,
  effects: Parameters<typeof appendPendingEffects>[2],
): void {
  if (!appendPendingEffects(db, fence, effects)) throw new FenceLostError();
}

function assertCurrentFence(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) throw new FenceLostError();
}
