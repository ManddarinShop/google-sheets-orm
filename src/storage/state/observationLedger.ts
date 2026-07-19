/**
 * Append-only observation and event ledger operations.
 *
 * These helpers run within the observation writer's already-fenced immediate
 * transaction. They do not perform canonical or conflict mutation themselves.
 */

import { randomUUID } from "node:crypto";
import {
  stableHash,
  type FieldConflict,
  type ObservedEditBatch,
  type ObservedRowChange,
} from "../../core/index.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { auditJson, rowHash } from "./observationAudit.js";
import type {
  ActiveCandidateRow,
  CreatedEvent,
  EventRow,
  ObservationAppendResult,
  ObservationAttemptInput,
  PersistObservedRowInput,
  ReceiptRow,
  RowBindingRow,
} from "./observationTypes.js";

/** Appends an observation occurrence and classifies receipt replay semantics. */
export function appendObservation(
  db: DatabaseSyncLike,
  batch: ObservedEditBatch,
  physicalSheetId: string,
  observation: ObservationAttemptInput,
): ObservationAppendResult {
  const receipt = db.prepare(`
    SELECT representative_payload_hash, event_id, state
    FROM observation_receipt
    WHERE logical_sheet_id = ? AND observation_key = ?
  `).get(batch.sheetId, observation.observationKey) as ReceiptRow | undefined;

  const samePayload = receipt !== undefined &&
    receipt.representative_payload_hash === observation.payloadHash;
  const linkedEventId = samePayload ? receipt.event_id : null;
  db.prepare(`
    INSERT INTO event_observation (
      observation_id, logical_sheet_id, physical_sheet_id, observation_key, event_id,
      source, payload_json, payload_hash, detected_at, received_at, ingress_actor_id,
      editor_actor_id, editor_actor_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.observationId,
    batch.sheetId,
    physicalSheetId,
    observation.observationKey,
    linkedEventId,
    batch.source,
    observation.payloadJson,
    observation.payloadHash,
    observation.detectedAt,
    observation.receivedAt,
    observation.ingressActorId,
    observation.editorActorId,
    observation.editorActorSource,
  );

  if (receipt === undefined) {
    db.prepare(`
      INSERT INTO observation_receipt (
        logical_sheet_id, observation_key, representative_payload_hash,
        first_observation_id, last_observation_id, event_id, state,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
    `).run(
      batch.sheetId,
      observation.observationKey,
      observation.payloadHash,
      observation.observationId,
      observation.observationId,
      observation.receivedAt,
      observation.receivedAt,
    );
    return { kind: "new", eventId: null };
  }

  const nextState = !samePayload
    ? receipt.state
    : receipt.state === "pending"
      ? "pending"
      : receipt.state === "quarantined"
        ? "quarantined"
        : "duplicate";
  db.prepare(`
    UPDATE observation_receipt
    SET last_observation_id = ?, last_seen_at = ?, state = ?
    WHERE logical_sheet_id = ? AND observation_key = ?
  `).run(
    observation.observationId,
    observation.receivedAt,
    nextState,
    batch.sheetId,
    observation.observationKey,
  );

  if (!samePayload) return { kind: "integrity_collision", eventId: null };
  if (receipt.state === "pending" && receipt.event_id === null) {
    return { kind: "pending_replay", eventId: null };
  }
  return { kind: "duplicate", eventId: receipt.event_id };
}

/** Completes the receipt after an event, duplicate, or quarantine outcome. */
export function completeObservation(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  observation: ObservationAttemptInput,
  eventId: string | null,
  state: "evaluated" | "duplicate" | "quarantined",
): void {
  db.prepare("UPDATE event_observation SET event_id = ? WHERE observation_id = ?")
    .run(eventId, observation.observationId);
  db.prepare(`
    UPDATE observation_receipt
    SET event_id = ?, state = ?
    WHERE logical_sheet_id = ? AND observation_key = ?
  `).run(eventId, state, logicalSheetId, observation.observationKey);
}

/** Requires the binding identity that makes an event-bearing observation safe. */
export function requireKnownBinding(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  rowBindingId: string,
): RowBindingRow {
  const binding = db.prepare(`
    SELECT entity_id, state
    FROM row_binding
    WHERE row_binding_id = ? AND logical_sheet_id = ?
  `).get(rowBindingId, logicalSheetId) as RowBindingRow | undefined;
  if (binding === undefined) {
    throw new Error("event-bearing observations require a known row binding");
  }
  return binding;
}

/** Finds a duplicate event represented by an unchanged active conflict candidate. */
export function findMatchingCandidateEventId(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  binding: RowBindingRow,
): string | null {
  if (
    input.evaluation.quarantine !== null ||
    input.evaluation.acceptedFields.length > 0 ||
    input.evaluation.conflicts.length === 0 ||
    binding.state !== "active" ||
    binding.entity_id === null
  ) {
    return null;
  }

  const eventIds = new Set<string>();
  for (const conflict of input.evaluation.conflicts) {
    const active = readActiveCandidate(
      db,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      conflict.fieldName,
    );
    if (
      active === null ||
      (active.status !== "OPEN" && active.status !== "NEEDS_REBASE") ||
      active.active_candidate_hash !== candidateHash(conflict)
    ) {
      return null;
    }
    eventIds.add(active.event_id);
  }
  return eventIds.size === 1 ? [...eventIds][0] ?? null : null;
}

/** Reads the currently visible unresolved candidate for one row field. */
export function readActiveCandidate(
  db: DatabaseSyncLike,
  physicalSheetId: string,
  projection: string,
  rowBindingId: string,
  fieldName: string,
): ActiveCandidateRow | null {
  const candidate = db.prepare(`
    SELECT visible.active_candidate_conflict_id, visible.active_candidate_hash,
           visible.candidate_epoch, conflict.event_id, conflict.status
    FROM sheet_visible_field_state AS visible
    JOIN sync_conflict AS conflict
      ON conflict.conflict_id = visible.active_candidate_conflict_id
    WHERE visible.physical_sheet_id = ? AND visible.projection = ?
      AND visible.row_binding_id = ? AND visible.field_name = ?
      AND visible.active_candidate_conflict_id IS NOT NULL
      AND visible.active_candidate_hash IS NOT NULL
  `).get(physicalSheetId, projection, rowBindingId, fieldName) as ActiveCandidateRow | undefined;
  return candidate ?? null;
}

/** Finds a prior event with the caller-supplied idempotency key. */
export function findEventByKey(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  eventKey: string,
): EventRow | null {
  const event = db.prepare(`
    SELECT event_id, payload_hash, event_sequence
    FROM event_log
    WHERE logical_sheet_id = ? AND event_key = ?
  `).get(logicalSheetId, eventKey) as EventRow | undefined;
  return event ?? null;
}

/** Creates the event log, row evidence, and field evidence for one new observation. */
export function createEvent(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
): CreatedEvent {
  const eventIdentity = input.event;
  if (eventIdentity === null) throw new Error("cannot create an event without an identity");
  ensureEventBatch(db, input);

  const sequenceRow = db.prepare(`
    SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
    FROM event_log
    WHERE logical_sheet_id = ?
  `).get(input.batch.sheetId) as { next_sequence: number } | undefined;
  const eventSequence = sequenceRow?.next_sequence;
  if (eventSequence === undefined || !Number.isSafeInteger(eventSequence)) {
    throw new Error("could not allocate the next event sequence");
  }

  const eventId = `event:${randomUUID()}`;
  const status = input.evaluation.quarantine !== null
    ? "quarantined"
    : input.evaluation.conflicts.length > 0
      ? "conflict"
      : "accepted";
  db.prepare(`
    INSERT INTO event_log (
      event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash,
      event_sequence, batch_id, row_binding_id, operation, status, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.batch.sheetId,
    input.physicalSheetId,
    eventIdentity.eventKey,
    eventIdentity.payloadHash,
    eventSequence,
    input.batch.batchId,
    row.rowBindingId,
    row.operation,
    status,
    input.observation.receivedAt,
  );
  db.prepare(`
    INSERT INTO event_row (event_id, before_row_json, after_row_json, before_hash, after_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    eventId,
    auditJson(row.beforeRow),
    auditJson(row.afterRow),
    rowHash(row.beforeRow, row.rowBindingId),
    rowHash(row.afterRow, row.rowBindingId),
  );
  for (const field of row.fields) {
    db.prepare(`
      INSERT INTO event_field (
        event_id, field_name, previous_value, next_value, base_field_revision
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      eventId,
      field.fieldName,
      auditJson(field.previousValue),
      auditJson(field.nextValue),
      field.baseFieldRevision,
    );
  }
  return { eventId, eventSequence };
}

/** Updates visible hashes after a new event has recorded its observed evidence. */
export function persistObservedHashes(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
): void {
  db.prepare(`
    UPDATE sheet_visible_state
    SET last_observed_hash = ?
    WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
  `).run(
    rowHash(row.afterRow, row.rowBindingId),
    input.physicalSheetId,
    input.batch.projection,
    row.rowBindingId,
  );
  for (const field of row.fields) {
    db.prepare(`
      UPDATE sheet_visible_field_state
      SET last_observed_field_hash = ?
      WHERE physical_sheet_id = ? AND projection = ?
        AND row_binding_id = ? AND field_name = ?
    `).run(
      stableHash(field.nextValue),
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      field.fieldName,
    );
  }
}

/** Produces the idempotency hash for a visible unresolved field candidate. */
export function candidateHash(conflict: FieldConflict): string {
  return stableHash({ value: conflict.userValue, revision: conflict.userBaseRevision });
}

function ensureEventBatch(db: DatabaseSyncLike, input: PersistObservedRowInput): void {
  const existing = db.prepare(`
    SELECT logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash
    FROM event_batch
    WHERE batch_id = ?
  `).get(input.batch.batchId) as {
    logical_sheet_id: string;
    physical_sheet_id: string;
    source: string;
    projection: string;
    atomicity: string;
    base_snapshot_hash: string;
  } | undefined;
  if (existing !== undefined) {
    const matches = existing.logical_sheet_id === input.batch.sheetId &&
      existing.physical_sheet_id === input.physicalSheetId &&
      existing.source === input.batch.source &&
      existing.projection === input.batch.projection &&
      existing.atomicity === input.batch.atomicity &&
      existing.base_snapshot_hash === input.batch.baseSnapshotHash;
    if (!matches) throw new Error("batch ID was replayed with different batch identity");
    return;
  }

  db.prepare(`
    INSERT INTO event_batch (
      batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.batch.batchId,
    input.batch.sheetId,
    input.physicalSheetId,
    input.batch.source,
    input.batch.projection,
    input.batch.atomicity,
    input.batch.baseSnapshotHash,
  );
}
