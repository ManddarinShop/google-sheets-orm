/**
 * Raw snapshot-ingestion ledger for the read-only Sheet integration phase.
 *
 * It persists authenticated snapshot evidence without creating a canonical
 * event or a Sheet effect.  Later evaluator work can consume the pending
 * observation receipt; a no-write shadow pass therefore never becomes a
 * hidden projection writer.
 */

import { withImmediateTransaction, type DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { isFencingValid, type FencingContext } from "../sync/writerLease.js";

/** One normalized snapshot evidence record captured from a registered projection. */
export interface ReadOnlySnapshotObservationInput {
  readonly observationId: string;
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly observationKey: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly source: "polling" | "onEdit";
  readonly detectedAt: number;
  readonly receivedAt: number;
  readonly ingressActorId: string;
  readonly editorActorId: string | null;
  readonly editorActorSource: "google_active_user" | "unavailable";
}

/** Durable outcome of appending raw, not-yet-evaluated snapshot evidence. */
export type ReadOnlySnapshotObservationResult =
  | { readonly kind: "fenced_out" }
  | { readonly kind: "captured"; readonly observationId: string }
  | { readonly kind: "duplicate"; readonly observationId: string }
  | { readonly kind: "integrity_collision"; readonly observationId: string };

/**
 * Appends a snapshot occurrence and maintains its representative receipt.
 *
 * The same observation key/payload is retained as another occurrence for
 * audit; a different payload under the same key is never silently deduped.
 */
export function persistReadOnlySnapshotObservation(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: ReadOnlySnapshotObservationInput,
): ReadOnlySnapshotObservationResult {
  validateInput(input);
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
  return withImmediateTransaction(db, () => {
    if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
    ensureRegisteredTarget(db, input);
    const receipt = db.prepare(`
      SELECT representative_payload_hash, event_id
      FROM observation_receipt
      WHERE logical_sheet_id = ? AND observation_key = ?
    `).get(input.logicalSheetId, input.observationKey) as ReceiptRow | undefined;
    const kind = receipt === undefined
      ? "captured"
      : receipt.representative_payload_hash === input.payloadHash
        ? "duplicate"
        : "integrity_collision";
    db.prepare(`
      INSERT INTO event_observation (
        observation_id, logical_sheet_id, physical_sheet_id, observation_key, event_id,
        source, payload_json, payload_hash, detected_at, received_at, ingress_actor_id,
        editor_actor_id, editor_actor_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.observationId,
      input.logicalSheetId,
      input.physicalSheetId,
      input.observationKey,
      receipt?.event_id ?? null,
      input.source,
      input.payloadJson,
      input.payloadHash,
      input.detectedAt,
      input.receivedAt,
      input.ingressActorId,
      input.editorActorId,
      input.editorActorSource,
    );
    if (receipt === undefined) {
      db.prepare(`
        INSERT INTO observation_receipt (
          logical_sheet_id, observation_key, representative_payload_hash,
          first_observation_id, last_observation_id, event_id, state,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
      `).run(
        input.logicalSheetId,
        input.observationKey,
        input.payloadHash,
        input.observationId,
        input.observationId,
        input.receivedAt,
        input.receivedAt,
      );
    } else {
      db.prepare(`
        UPDATE observation_receipt SET last_observation_id = ?, last_seen_at = ?
        WHERE logical_sheet_id = ? AND observation_key = ?
      `).run(input.observationId, input.receivedAt, input.logicalSheetId, input.observationKey);
    }
    return { kind, observationId: input.observationId };
  });
}

interface ReceiptRow {
  readonly representative_payload_hash: string;
  readonly event_id: string | null;
}

function ensureRegisteredTarget(db: DatabaseSyncLike, input: ReadOnlySnapshotObservationInput): void {
  const row = db.prepare(`
    SELECT physical.enabled AS physical_enabled, physical.logical_sheet_id,
           logical.enabled AS logical_enabled
    FROM physical_sheet_registry AS physical
    JOIN sheet_registry AS logical ON logical.sheet_id = physical.logical_sheet_id
    WHERE physical.physical_sheet_id = ?
  `).get(input.physicalSheetId) as {
    physical_enabled: number;
    logical_sheet_id: string;
    logical_enabled: number;
  } | undefined;
  if (row === undefined || row.physical_enabled !== 1 || row.logical_enabled !== 1 ||
    row.logical_sheet_id !== input.logicalSheetId) {
    throw new Error("read-only snapshot target is not an enabled registered projection");
  }
}

function validateInput(input: ReadOnlySnapshotObservationInput): void {
  for (const [label, value] of [
    ["observation ID", input.observationId],
    ["physical sheet ID", input.physicalSheetId],
    ["logical sheet ID", input.logicalSheetId],
    ["observation key", input.observationKey],
    ["payload JSON", input.payloadJson],
    ["payload hash", input.payloadHash],
    ["ingress actor ID", input.ingressActorId],
  ] as const) {
    if (value.length === 0) throw new Error(label + " is required");
  }
  if (input.source !== "polling" && input.source !== "onEdit") throw new Error("invalid observation source");
  for (const [label, value] of [["detectedAt", input.detectedAt], ["receivedAt", input.receivedAt]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + " must be a non-negative safe integer");
  }
  if (input.editorActorSource === "google_active_user" &&
    (typeof input.editorActorId !== "string" || input.editorActorId.length === 0)) {
    throw new Error("verified editor source requires an editor actor ID");
  }
  if (input.editorActorSource === "unavailable" && input.editorActorId !== null) {
    throw new Error("unavailable editor source cannot include an editor actor ID");
  }
}
