/**
 * Fail-closed validation before field-level conflict evaluation.
 *
 * These checks reject ambiguous identity, invalid normalized values, schema
 * drift, and unsupported operation shapes before any canonical field CAS is
 * considered.
 */

import type { NormalizedCell } from "../encoding/types.js";
import { stableHash } from "../encoding/stableEncode.js";
import type {
  CanonicalEntityState,
  ObservedFieldChange,
  ObservedRowChange,
  OwnershipManifest,
  QuarantineReason,
  RowBindingContext,
} from "../model/types.js";
import type { EvaluationContext } from "./contracts.js";

/** Summary of editable and system-owned fields in one observed row. */
export interface OwnershipCheckResult {
  readonly hasSystemField: boolean;
  readonly hasUserField: boolean;
  readonly systemFields: readonly { fieldName: string; value: NormalizedCell }[];
}

/** Validates operation, field identity, and normalized-cell input shape. */
export function validateStructuralPreconditions(row: ObservedRowChange): QuarantineReason | null {
  if (!isValidOperation(row.operation) || row.fields.length === 0) {
    return "invalid_event";
  }

  const seenFields = new Set<string>();
  for (const field of row.fields) {
    if (field.fieldName.length === 0 || seenFields.has(field.fieldName)) {
      return "invalid_event";
    }
    seenFields.add(field.fieldName);

    if (!isNormalizedCell(field.previousValue) || !isNormalizedCell(field.nextValue)) {
      return "invalid_cell";
    }
    if (
      field.baseFieldRevision !== null &&
      (!Number.isSafeInteger(field.baseFieldRevision) || field.baseFieldRevision < 0)
    ) {
      return "invalid_event";
    }
  }

  return null;
}

/** Checks whether the operation is legal for the row binding's current state. */
export function validateBindingState(
  operation: string,
  binding: RowBindingContext,
): QuarantineReason | null {
  switch (operation) {
    case "insert":
      return binding.bindingState === "candidate" && binding.entityId === null
        ? null
        : "ambiguous_identity";
    case "update":
    case "rename":
    case "delete":
      return binding.bindingState === "active" && binding.entityId !== null
        ? null
        : "ambiguous_identity";
    default:
      return "invalid_event";
  }
}

/** Rejects a row that references a field absent from the ownership manifest. */
export function validateManifestFields(
  fields: readonly ObservedFieldChange[],
  manifest: OwnershipManifest,
): QuarantineReason | null {
  return fields.some((field) => !manifest.has(field.fieldName)) ? "unknown_field" : null;
}

/** Applies operation-specific evidence, required-field, and unique-key checks. */
export function validateOperationPreconditions(
  row: ObservedRowChange,
  binding: RowBindingContext,
  canonical: CanonicalEntityState | null,
  context: EvaluationContext,
): QuarantineReason | null {
  if (row.operation === "insert") {
    if (row.beforeRow !== null || row.baseEntityRevision !== null || row.deleteEvidence !== null) {
      return "invalid_event";
    }
    return validateRequiredInsertFields(row, context.manifest)
      ?? validateUniqueBusinessKeys(row, binding, context);
  }

  if (canonical === null) return "ambiguous_identity";

  if (row.operation === "delete") {
    if (row.deleteEvidence !== "deleted_confirmed") return "anchor_lost";
    return row.beforeRow !== null &&
      row.afterRow === null &&
      row.baseEntityRevision === canonical.entityRevision
      ? null
      : "invalid_event";
  }

  if (row.deleteEvidence !== null) return "invalid_event";
  if (row.fields.some((field) => field.baseFieldRevision === null)) return "unknown_base_revision";
  if (row.fields.some((field) => canonical.fields.get(field.fieldName) === undefined)) {
    return "schema_drift";
  }

  return row.operation === "rename"
    ? validateUniqueBusinessKeys(row, binding, context)
    : null;
}

/** Separates illegal system fields from user-owned fields without resolving them. */
export function inspectOwnership(
  fields: readonly ObservedFieldChange[],
  manifest: OwnershipManifest,
): OwnershipCheckResult {
  const systemFields: Array<{ fieldName: string; value: NormalizedCell }> = [];
  let hasUserField = false;

  for (const field of fields) {
    const entry = manifest.get(field.fieldName);
    if (entry !== undefined && entry.ownership === "system") {
      systemFields.push({ fieldName: field.fieldName, value: field.nextValue });
    } else {
      hasUserField = true;
    }
  }

  return {
    hasSystemField: systemFields.length > 0,
    hasUserField,
    systemFields,
  };
}

function isValidOperation(operation: string): boolean {
  return operation === "insert" || operation === "update" || operation === "delete" || operation === "rename";
}

function validateRequiredInsertFields(
  row: ObservedRowChange,
  manifest: OwnershipManifest,
): QuarantineReason | null {
  const fieldsByName = new Map(row.fields.map((field) => [field.fieldName, field]));
  for (const entry of manifest.values()) {
    if (!entry.required) continue;
    const field = fieldsByName.get(entry.fieldName);
    if (field === undefined || !hasRequiredValue(field.nextValue)) return "invalid_event";
  }
  return null;
}

function validateUniqueBusinessKeys(
  row: ObservedRowChange,
  binding: RowBindingContext,
  context: EvaluationContext,
): QuarantineReason | null {
  for (const field of row.fields) {
    const manifestEntry = context.manifest.get(field.fieldName);
    if (manifestEntry === undefined || !manifestEntry.unique) continue;
    if (!hasRequiredValue(field.nextValue)) return "invalid_event";

    const owner = context.businessKeyEntityIdsByField
      .get(field.fieldName)
      ?.get(stableHash(field.nextValue));
    if (owner !== undefined && owner !== binding.entityId) return "ambiguous_identity";
  }
  return null;
}

function hasRequiredValue(value: NormalizedCell): boolean {
  return value !== null && !(value.kind === "string" && value.value.length === 0);
}

/** Narrows untrusted adapter input to the versioned normalized-cell contract. */
function isNormalizedCell(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;

  const candidate = value as { readonly kind?: unknown; readonly value?: unknown };
  switch (candidate.kind) {
    case "string":
      return typeof candidate.value === "string";
    case "number":
      return typeof candidate.value === "number" && Number.isFinite(candidate.value);
    case "boolean":
      return typeof candidate.value === "boolean";
    case "date":
      return typeof candidate.value === "string" && isCanonicalDate(candidate.value);
    default:
      return false;
  }
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
