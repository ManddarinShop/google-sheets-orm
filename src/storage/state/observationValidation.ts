/**
 * Input and registry validation for the observation writer.
 *
 * Validation happens before the writer opens its transaction so malformed
 * adapter input never creates a partial receipt or event occurrence.
 */

import { stableHash } from "../../core/index.js";
import type { ObservedEditBatch } from "../../core/index.js";
import type { NewEffect } from "../sync/effectOutbox.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import type {
  CanonicalRowMutation,
  ObservationAttemptInput,
  PersistObservedRowInput,
} from "./observationTypes.js";

/** Validates one complete writer submission before durable mutation begins. */
export function validatePersistObservedRowInput(input: PersistObservedRowInput): void {
  const row = requireBatchRow(input.batch, input.rowIndex);
  if (input.physicalSheetId.length === 0) throw new Error("physical sheet ID is required");
  if (input.batch.sheetId.length === 0 || input.batch.batchId.length === 0) {
    throw new Error("logical sheet ID and batch ID are required");
  }
  if (input.evaluation.rowBindingId !== row.rowBindingId) {
    throw new Error("evaluation row binding does not match the observed row");
  }
  validateObservation(input.observation);
  if (input.event !== null && (input.event.eventKey.length === 0 || input.event.payloadHash.length === 0)) {
    throw new Error("event key and payload hash are required when an event is present");
  }
  if (input.event === null && input.evaluation.quarantine === null) {
    throw new Error("only quarantined rows may omit an event identity");
  }
  if (input.evaluation.quarantine !== null && input.canonical !== null) {
    throw new Error("a quarantined row cannot carry a canonical mutation");
  }

  const needsCanonical = input.evaluation.acceptedFields.length > 0 ||
    (row.operation === "delete" && input.evaluation.outcome === "accepted");
  if (needsCanonical !== (input.canonical !== null)) {
    throw new Error("accepted canonical work must have exactly one canonical mutation");
  }
  if (input.canonical !== null) validateCanonicalMutation(input.canonical, row.operation, input.evaluation);
  validateEffects(input.effects, input.batch);
  if (input.canonical !== null) validateEffects(input.canonical.commit.effects, input.batch);
}

/** Requires a valid row index and returns its observed row. */
export function requireBatchRow(batch: ObservedEditBatch, rowIndex: number) {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) {
    throw new Error("row index must be a non-negative safe integer");
  }
  const row = batch.rows[rowIndex];
  if (row === undefined) throw new Error("row index is outside the observed batch");
  return row;
}

/** Ensures the observed physical projection is an enabled registry member. */
export function ensureRegisteredProjection(
  db: DatabaseSyncLike,
  batch: ObservedEditBatch,
  physicalSheetId: string,
): void {
  const row = db.prepare(`
    SELECT logical_sheet_id, projection, enabled
    FROM physical_sheet_registry
    WHERE physical_sheet_id = ?
  `).get(physicalSheetId) as
    | { logical_sheet_id: string; projection: string; enabled: number }
    | undefined;
  if (
    row === undefined ||
    row.logical_sheet_id !== batch.sheetId ||
    row.projection !== batch.projection ||
    row.enabled !== 1
  ) {
    throw new Error("physical sheet is not an enabled projection of the observed logical sheet");
  }

  const logical = db.prepare("SELECT enabled FROM sheet_registry WHERE sheet_id = ?")
    .get(batch.sheetId) as { enabled: number } | undefined;
  if (logical === undefined || logical.enabled !== 1) {
    throw new Error("logical sheet is not enabled");
  }
}

/** Ensures every generated effect targets an enabled registered projection. */
export function ensureEffectsTargetRegistered(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  effects: readonly NewEffect[],
): void {
  for (const effect of effects) {
    const target = db.prepare(`
      SELECT logical_sheet_id, projection, enabled
      FROM physical_sheet_registry
      WHERE physical_sheet_id = ?
    `).get(effect.physicalSheetId) as
      | { logical_sheet_id: string; projection: string; enabled: number }
      | undefined;
    if (
      target === undefined ||
      target.logical_sheet_id !== logicalSheetId ||
      target.projection !== effect.projection ||
      target.enabled !== 1
    ) {
      throw new Error("effect targets an unregistered physical projection");
    }
  }
}

function validateObservation(observation: ObservationAttemptInput): void {
  if (
    observation.observationId.length === 0 ||
    observation.observationKey.length === 0 ||
    observation.payloadJson.length === 0 ||
    observation.payloadHash.length === 0 ||
    observation.ingressActorId.length === 0
  ) {
    throw new Error("observation identity, payload, and ingress actor are required");
  }
  for (const [name, value] of [["detectedAt", observation.detectedAt], ["receivedAt", observation.receivedAt]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  if (observation.editorActorSource === "google_active_user" && observation.editorActorId === null) {
    throw new Error("a verified editor source requires an editor actor ID");
  }
  if (observation.editorActorSource === "unavailable" && observation.editorActorId !== null) {
    throw new Error("an unavailable editor source cannot claim an editor actor ID");
  }
}

function validateCanonicalMutation(
  mutation: CanonicalRowMutation,
  operation: string,
  evaluation: PersistObservedRowInput["evaluation"],
): void {
  if (mutation.commitId.length === 0) throw new Error("canonical commit ID is required");
  const expectedKind = operation === "insert" ? "insert" : operation === "delete" ? "delete" : "update";
  if (mutation.commit.kind !== expectedKind) {
    throw new Error(`observed ${operation} requires a ${expectedKind} canonical mutation`);
  }

  if (mutation.commit.kind !== "delete") {
    const acceptedByName = new Map(evaluation.acceptedFields.map((field) => [field.fieldName, field]));
    if (acceptedByName.size !== mutation.commit.fields.length) {
      throw new Error("canonical fields must exactly match accepted fields");
    }
    for (const field of mutation.commit.fields) {
      const accepted = acceptedByName.get(field.fieldName);
      if (accepted === undefined || stableHash(field.value) !== stableHash(accepted.nextValue)) {
        throw new Error(`canonical field ${field.fieldName} does not match the core result`);
      }
      const expectedRevision = mutation.commit.kind === "insert" ? null : accepted.nextFieldRevision - 1;
      if (field.expectedFieldRevision !== expectedRevision) {
        throw new Error(`canonical field ${field.fieldName} has an unexpected base revision`);
      }
    }
  }

  const keyNames = new Set<string>();
  for (const change of mutation.businessKeyChanges) {
    if (change.fieldName.length === 0 || keyNames.has(change.fieldName)) {
      throw new Error("business key changes must have unique non-empty field names");
    }
    keyNames.add(change.fieldName);
    if (
      (change.previousNormalizedKey !== null && change.previousNormalizedKey.length === 0) ||
      (change.nextNormalizedKey !== null && change.nextNormalizedKey.length === 0)
    ) {
      throw new Error("business key hashes cannot be empty strings");
    }
  }
}

function validateEffects(effects: readonly NewEffect[], batch: ObservedEditBatch): void {
  for (const effect of effects) {
    if (
      effect.logicalSheetId !== batch.sheetId ||
      effect.physicalSheetId.length === 0 ||
      effect.projection.length === 0
    ) {
      throw new Error("effect must target a registered physical projection of the logical sheet");
    }
  }
}
