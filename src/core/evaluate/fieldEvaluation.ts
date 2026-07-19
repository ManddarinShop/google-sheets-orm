/**
 * Field-level canonical compare-and-set evaluation.
 *
 * This module never mutates canonical state. It classifies each user-owned
 * field as accepted or conflicting so the storage writer can commit one
 * row-independent decision atomically later.
 */

import type { NormalizedCell } from "../encoding/types.js";
import type {
  CanonicalEntityState,
  ObservedFieldChange,
  ObservedRowChange,
} from "../model/types.js";
import type {
  AcceptedField,
  EvaluationContext,
  FieldConflict,
  RowEvaluationResult,
  RowOutcome,
} from "./contracts.js";

/** Evaluates all user-owned fields after structural/ownership checks passed. */
export function evaluateUserFields(
  row: ObservedRowChange,
  canonical: CanonicalEntityState | null,
  context: EvaluationContext,
): RowEvaluationResult {
  const accepted: AcceptedField[] = [];
  const conflicts: FieldConflict[] = [];

  for (const fieldChange of row.fields) {
    const result = evaluateSingleUserField(fieldChange, canonical, row, context);
    if (result.kind === "accepted") accepted.push(result.field);
    else conflicts.push(result.conflict);
  }

  const outcome = classifyFieldOutcome(accepted, conflicts);
  const nextEntityRevision = accepted.length > 0
    ? canonical === null ? 1 : canonical.entityRevision + 1
    : null;

  return {
    rowBindingId: row.rowBindingId,
    outcome,
    acceptedFields: accepted,
    conflicts,
    quarantine: null,
    repairPlan: null,
    nextEntityRevision,
  };
}

/** Produces an accepted tombstone without treating delete fields as updates. */
export function acceptedDelete(
  row: ObservedRowChange,
  canonical: CanonicalEntityState,
): RowEvaluationResult {
  return {
    rowBindingId: row.rowBindingId,
    outcome: "accepted",
    acceptedFields: [],
    conflicts: [],
    quarantine: null,
    repairPlan: null,
    nextEntityRevision: canonical.entityRevision + 1,
  };
}

type FieldEvaluationResult =
  | { readonly kind: "accepted"; readonly field: AcceptedField }
  | { readonly kind: "conflict"; readonly conflict: FieldConflict };

function evaluateSingleUserField(
  fieldChange: ObservedFieldChange,
  canonical: CanonicalEntityState | null,
  row: ObservedRowChange,
  context: EvaluationContext,
): FieldEvaluationResult {
  if (hasActiveConflict(context, row.rowBindingId, fieldChange.fieldName)) {
    return conflictResult(fieldChange, canonical);
  }

  if (row.operation === "insert" || canonical === null) {
    return {
      kind: "accepted",
      field: {
        fieldName: fieldChange.fieldName,
        nextValue: fieldChange.nextValue,
        nextFieldRevision: 1,
      },
    };
  }

  const currentField = canonical.fields.get(fieldChange.fieldName);
  if (currentField === undefined || fieldChange.baseFieldRevision !== currentField.fieldRevision) {
    return conflictResult(fieldChange, canonical);
  }

  return {
    kind: "accepted",
    field: {
      fieldName: fieldChange.fieldName,
      nextValue: fieldChange.nextValue,
      nextFieldRevision: currentField.fieldRevision + 1,
    },
  };
}

function classifyFieldOutcome(
  accepted: readonly AcceptedField[],
  conflicts: readonly FieldConflict[],
): RowOutcome {
  if (conflicts.length === 0) return "accepted";
  return accepted.length > 0 ? "partially_accepted" : "conflict";
}

function conflictResult(
  fieldChange: ObservedFieldChange,
  canonical: CanonicalEntityState | null,
): FieldEvaluationResult {
  const currentField = canonical?.fields.get(fieldChange.fieldName);
  return {
    kind: "conflict",
    conflict: {
      fieldName: fieldChange.fieldName,
      userValue: fieldChange.nextValue,
      userBaseRevision: fieldChange.baseFieldRevision ?? 0,
      canonicalValue: currentField?.value ?? null,
      canonicalRevision: currentField?.fieldRevision ?? 0,
    },
  };
}

function hasActiveConflict(
  context: EvaluationContext,
  rowBindingId: string,
  fieldName: string,
): boolean {
  const conflict = context.activeConflictsByBindingAndField.get(rowBindingId)?.get(fieldName);
  return conflict?.status === "OPEN" || conflict?.status === "NEEDS_REBASE";
}
