/**
 * Deterministic identity helpers for observed rows, events, and repairs.
 *
 * Storage records the resulting values but does not choose their contents;
 * identical normalized input must always produce the same identity.
 */

import type { NormalizedCell } from "../encoding/types.js";
import { stableHash } from "../encoding/stableEncode.js";
import type { EventKeyField } from "./contracts.js";

/** Computes the source-independent event key for a normalized row change. */
export function computeEventKey(input: {
  readonly schemaVersion: number;
  readonly sheetId: string;
  readonly projection: string;
  readonly rowBindingId: string;
  readonly baseVisibleRevision: number;
  readonly baseSnapshotHash: string;
  readonly operation: string;
  readonly beforeRowHash: string;
  readonly afterRowHash: string;
  readonly changedFields: readonly EventKeyField[];
}): string {
  const changedFields = [...input.changedFields].sort((left, right) =>
    compareText(left.fieldName, right.fieldName),
  );
  for (let index = 1; index < changedFields.length; index += 1) {
    if (changedFields[index - 1]!.fieldName === changedFields[index]!.fieldName) {
      throw new Error(`event key cannot contain duplicate field ${changedFields[index]!.fieldName}`);
    }
  }

  return stableHash({
    schemaVersion: input.schemaVersion,
    sheetId: input.sheetId,
    projection: input.projection,
    rowBindingId: input.rowBindingId,
    baseVisibleRevision: input.baseVisibleRevision,
    baseSnapshotHash: input.baseSnapshotHash,
    operation: input.operation,
    beforeRowHash: input.beforeRowHash,
    afterRowHash: input.afterRowHash,
    changedFields: changedFields.map((field) => ({
      fieldName: field.fieldName,
      baseFieldRevision: field.baseFieldRevision,
      candidateEpoch: field.candidateEpoch,
      beforeHash: field.beforeHash,
      afterHash: field.afterHash,
      nextValue: field.nextValue,
    })),
  });
}

/** Computes a stable hash for a normalized row's field values. */
export function computeRowHash(
  rowBindingId: string,
  fields: ReadonlyMap<string, { readonly cell: NormalizedCell }>,
): string {
  const entries = [...fields.entries()].sort((left, right) => compareText(left[0], right[0]));
  return stableHash({
    rowBindingId,
    fields: entries.map(([name, field]) => [name, field.cell]),
  });
}

/** Computes the visible-state guard used by a system-field repair effect. */
export function computeRepairGuardHash(
  rowBindingId: string,
  illegalFields: ReadonlyArray<readonly [string, NormalizedCell]>,
): string {
  return stableHash({
    rowBindingId,
    illegalFields: [...illegalFields].sort((left, right) => compareText(left[0], right[0])),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
