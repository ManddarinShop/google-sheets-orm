/**
 * Stable audit serialization for observation evidence.
 *
 * Gateway payloads are external input, so rejected values must still be
 * preserved without JSON coercion silently hiding malformed data.
 */

import { computeRowHash, stableHash, type ObservedRowChange } from "../../core/index.js";

/** Builds the persisted hash for an observed row snapshot or absent row. */
export function rowHash(
  row: ObservedRowChange["beforeRow"],
  rowBindingId: string,
): string {
  return row === null
    ? stableHash({ rowBindingId, row: null })
    : computeRowHash(row.rowBindingId, row.fields);
}

/**
 * Produces non-throwing audit JSON for rejected adapter values as well as
 * valid normalized values. It never lets JSON.stringify silently turn
 * Infinity into null or discard undefined evidence.
 */
export function auditJson(value: unknown): string {
  const serialized = JSON.stringify(toAuditValue(value, new Set<object>()));
  if (serialized === undefined) throw new Error("could not serialize audit evidence");
  return serialized;
}

type AuditValue = null | boolean | number | string | readonly AuditValue[] | {
  readonly [key: string]: AuditValue;
};

function toAuditValue(value: unknown, seen: Set<object>): AuditValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $invalidNumber: String(value) };
  }
  if (typeof value === "undefined") return { $invalidType: "undefined" };
  if (typeof value === "bigint") return { $invalidBigInt: value.toString() };
  if (typeof value === "symbol") return { $invalidSymbol: String(value) };
  if (typeof value === "function") return { $invalidFunction: value.name || "anonymous" };

  if (seen.has(value)) return { $invalidObject: "cycle" };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toAuditValue(entry, seen));
    }
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(([key, entry]) => [toAuditValue(key, seen), toAuditValue(entry, seen)] as const)
        .sort((left, right) => auditSortKey(left[0]).localeCompare(auditSortKey(right[0])));
      return { $map: entries };
    }
    if (Object.prototype.toString.call(value) !== "[object Object]") {
      return { $invalidObject: Object.prototype.toString.call(value) };
    }

    const objectValue = value as Record<string, unknown>;
    const result: Record<string, AuditValue> = {};
    for (const key of Object.keys(objectValue).sort()) {
      result[key] = toAuditValue(objectValue[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function auditSortKey(value: AuditValue): string {
  return JSON.stringify(value);
}
