/**
 * Pure row-independent observation evaluator.
 *
 * It composes the precondition, ownership, quarantine, and field-CAS modules
 * without performing I/O or mutating canonical state.
 */

import type {
  CanonicalEntityState,
  ObservedEditBatch,
  ObservedRowChange,
} from "../model/types.js";
import type {
  BatchEvaluationResult,
  BatchOutcome,
  EvaluationContext,
  RowEvaluationResult,
} from "./contracts.js";
import { acceptedDelete, evaluateUserFields } from "./fieldEvaluation.js";
import {
  inspectOwnership,
  validateBindingState,
  validateManifestFields,
  validateOperationPreconditions,
  validateStructuralPreconditions,
} from "./preconditions.js";
import { quarantineRow, quarantineSystemRow } from "./quarantine.js";

/** Evaluates each normalized row independently against the supplied canonical context. */
export function evaluateBatch(
  batch: ObservedEditBatch,
  context: EvaluationContext,
): BatchEvaluationResult {
  if (batch.schemaVersion !== context.schemaVersion) {
    return {
      batchId: batch.batchId,
      rowResults: batch.rows.map((row) => quarantineRow(row, "schema_drift")),
      overallOutcome: "quarantine",
    };
  }

  const rowResults = batch.rows.map((row) => evaluateRow(row, context));
  return {
    batchId: batch.batchId,
    rowResults,
    overallOutcome: summarizeBatch(rowResults),
  };
}

function evaluateRow(
  row: ObservedRowChange,
  context: EvaluationContext,
): RowEvaluationResult {
  const structuralError = validateStructuralPreconditions(row);
  if (structuralError !== null) return quarantineRow(row, structuralError);

  const binding = context.bindingByBindingId.get(row.rowBindingId);
  if (binding === undefined) return quarantineRow(row, "ambiguous_identity");

  const bindingError = validateBindingState(row.operation, binding);
  if (bindingError !== null) return quarantineRow(row, bindingError);

  const canonical = binding.entityId === null
    ? null
    : context.canonicalByBindingId.get(row.rowBindingId) ?? null;
  if (binding.entityId !== null && (canonical === null || canonical.entityId !== binding.entityId)) {
    return quarantineRow(row, "ambiguous_identity");
  }

  const manifestError = validateManifestFields(row.fields, context.manifest);
  if (manifestError !== null) return quarantineRow(row, manifestError);

  const operationError = validateOperationPreconditions(row, binding, canonical, context);
  if (operationError !== null) return quarantineRow(row, operationError);

  const ownership = inspectOwnership(row.fields, context.manifest);
  if (ownership.hasSystemField) return quarantineSystemRow(row, canonical, ownership);

  return row.operation === "delete"
    ? acceptedDelete(row, requireCanonical(canonical))
    : evaluateUserFields(row, canonical, context);
}

function summarizeBatch(results: readonly RowEvaluationResult[]): BatchOutcome {
  if (results.some((result) => result.outcome === "quarantine")) return "quarantine";
  if (results.some((result) => result.outcome === "conflict")) return "conflict";
  return results.some((result) => result.outcome === "partially_accepted")
    ? "partially_accepted"
    : "accepted";
}

function requireCanonical(canonical: CanonicalEntityState | null): CanonicalEntityState {
  if (canonical === null) throw new Error("delete evaluation requires canonical state");
  return canonical;
}
