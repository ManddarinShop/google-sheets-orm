/** Quarantine persistence for invalid or unresolvable observed rows. */

import { stableHash, type ObservedRowChange, type QuarantinePlan } from "../../core/index.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { auditJson } from "./observationAudit.js";
import type { PersistObservedRowInput } from "./observationTypes.js";

/** Persists a deterministic quarantine for incompatible receipt or event identity. */
export function persistIntegrityQuarantine(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  eventId: string | null,
  discriminator: "observation_key_payload_mismatch" | "event_key_payload_mismatch",
): string {
  const quarantine: QuarantinePlan = {
    quarantineId: `q-${stableHash({
      logicalSheetId: input.batch.sheetId,
      observationKey: input.observation.observationKey,
      representative: discriminator,
      payloadHash: input.observation.payloadHash,
      rowBindingId: row.rowBindingId,
    })}`,
    reason: "invalid_event",
    rowBindingId: row.rowBindingId,
    beforeRow: row.beforeRow,
    afterRow: row.afterRow,
    fields: row.fields,
    repairFields: [],
  };
  return persistQuarantine(db, input, quarantine, eventId);
}

/** Inserts a core-provided quarantine plan once and retains its raw evidence. */
export function persistQuarantine(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  quarantine: QuarantinePlan,
  eventId: string | null,
): string {
  db.prepare(`
    INSERT INTO quarantine_record (
      quarantine_id, event_id, observation_id, logical_sheet_id, row_binding_id,
      reason, before_row_json, after_row_json, fields_json, repair_fields_json,
      repair_state, candidate_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(quarantine_id) DO NOTHING
  `).run(
    quarantine.quarantineId,
    eventId,
    input.observation.observationId,
    input.batch.sheetId,
    quarantine.rowBindingId,
    quarantine.reason,
    auditJson(quarantine.beforeRow),
    auditJson(quarantine.afterRow),
    auditJson(quarantine.fields),
    auditJson(quarantine.repairFields),
    input.evaluation.repairPlan === null ? null : "pending",
    input.observation.payloadJson,
    input.observation.receivedAt,
    input.observation.receivedAt,
  );
  return quarantine.quarantineId;
}
