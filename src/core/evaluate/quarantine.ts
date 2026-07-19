/**
 * Deterministic quarantine and repair-plan builders.
 *
 * Invalid external values are converted to encodable audit fingerprints so a
 * rejected retry remains idempotent instead of failing while constructing its
 * quarantine identity.
 */

import type { NormalizedCell, StableValue } from "../encoding/types.js";
import { stableHash } from "../encoding/stableEncode.js";
import type {
  CanonicalEntityState,
  ObservedRowChange,
  QuarantinePlan,
  QuarantineReason,
  RepairPlan,
} from "../model/types.js";
import type { RowEvaluationResult } from "./contracts.js";
import { computeRepairGuardHash } from "./identity.js";
import type { OwnershipCheckResult } from "./preconditions.js";

/** Builds a terminal row result for evidence that cannot safely be applied. */
export function quarantineRow(
  row: ObservedRowChange,
  reason: QuarantineReason,
): RowEvaluationResult {
  return {
    rowBindingId: row.rowBindingId,
    outcome: "quarantine",
    acceptedFields: [],
    conflicts: [],
    quarantine: makeQuarantinePlan(row, reason, []),
    repairPlan: null,
    nextEntityRevision: null,
  };
}

/** Produces a quarantine plus a guarded repair plan for illegal system edits. */
export function quarantineSystemRow(
  row: ObservedRowChange,
  canonical: CanonicalEntityState | null,
  ownership: OwnershipCheckResult,
): RowEvaluationResult {
  const reason: QuarantineReason = ownership.hasUserField
    ? "mixed_ownership_edit"
    : "system_field_edit";
  const quarantine = makeQuarantinePlan(
    row,
    reason,
    ownership.systemFields.map((field) => field.fieldName),
  );
  const repairPlan = canonical === null
    ? null
    : makeRepairPlan(quarantine, row, ownership.systemFields, canonical);

  if (canonical !== null && repairPlan === null) return quarantineRow(row, "schema_drift");

  return {
    rowBindingId: row.rowBindingId,
    outcome: "quarantine",
    acceptedFields: [],
    conflicts: [],
    quarantine,
    repairPlan,
    nextEntityRevision: null,
  };
}

function makeQuarantinePlan(
  row: ObservedRowChange,
  reason: QuarantineReason,
  repairFields: readonly string[],
): QuarantinePlan {
  return {
    quarantineId: `q-${stableHash({
      rowBindingId: row.rowBindingId,
      operation: row.operation,
      reason,
      baseVisibleRevision: row.baseVisibleRevision,
      fields: row.fields.map((field) => ({
        fieldName: field.fieldName,
        baseFieldRevision: field.baseFieldRevision,
        previousValue: quarantineFingerprintValue(field.previousValue),
        nextValue: quarantineFingerprintValue(field.nextValue),
      })),
    })}`,
    reason,
    rowBindingId: row.rowBindingId,
    beforeRow: row.beforeRow,
    afterRow: row.afterRow,
    fields: row.fields,
    repairFields,
  };
}

function quarantineFingerprintValue(value: unknown, seen: Set<object> = new Set()): StableValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { invalidNumber: String(value) };
  }
  if (typeof value === "undefined") return { invalidType: "undefined" };
  if (typeof value === "bigint") return { invalidBigInt: value.toString() };
  if (typeof value === "symbol") return { invalidSymbol: String(value) };
  if (typeof value === "function") return { invalidFunction: value.name || "anonymous" };

  if (seen.has(value)) return { invalidObject: "cycle" };
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => quarantineFingerprintValue(entry, seen));
    if (Object.prototype.toString.call(value) !== "[object Object]") {
      return { invalidObject: Object.prototype.toString.call(value) };
    }

    const record = value as Record<string, unknown>;
    const normalized: Record<string, StableValue> = {};
    for (const key of Object.keys(record)) {
      normalized[key] = quarantineFingerprintValue(record[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function makeRepairPlan(
  quarantine: QuarantinePlan,
  row: ObservedRowChange,
  systemFields: readonly { fieldName: string; value: NormalizedCell }[],
  canonical: CanonicalEntityState,
): RepairPlan | null {
  const targetValues = new Map<string, NormalizedCell>();
  for (const systemField of systemFields) {
    const canonicalField = canonical.fields.get(systemField.fieldName);
    if (canonicalField === undefined || canonicalField.ownership !== "system") return null;
    targetValues.set(systemField.fieldName, canonicalField.value);
  }
  return {
    quarantineId: quarantine.quarantineId,
    rowBindingId: row.rowBindingId,
    affectedSystemFields: systemFields.map((field) => field.fieldName),
    canonicalTargetValues: targetValues,
    repairGuardHash: computeRepairGuardHash(
      row.rowBindingId,
      systemFields.map((field) => [field.fieldName, field.value]),
    ),
    reason: "system_field_edit",
  };
}
