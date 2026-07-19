/**
 * Normalized cell and stable encoding types.
 *
 * These types are the foundation for cross-runtime fingerprinting and event
 * identity. They contain no Google SDK, SQLite, or platform-specific types.
 */

/** A date encoded as a fixed-width UTC ISO-8601 string. */
export interface DateValue {
  readonly kind: "date";
  readonly value: string; // YYYY-MM-DDTHH:mm:ss.SSSZ
}

/**
 * A normalized scalar value that can be deterministically encoded.
 *
 * `null` represents an empty cell. An explicit empty string is
 * `{ kind: "string", value: "" }`.
 */
export type NormalizedCell =
  | null
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | DateValue;

/**
 * Metadata describing the physical state of a Sheet cell, separate from its
 * normalized value. Used by observation to decide whether a cell can be
 * processed or must be quarantined.
 */
export interface CellObservation {
  readonly cellKind: "blank" | "literal" | "formula" | "merged" | "error";
  readonly normalizedCell: NormalizedCell;
  readonly formulaHash: string | null;
  readonly mergeRange: string | null;
  readonly errorCode: string | null;
}

/**
 * Any value that stable_encode_v1 can encode: scalars, arrays, dates, and
 * objects with string keys. Objects with `kind: "date"` are encoded as dates,
 * not as plain objects.
 */
export type StableValue =
  | null
  | boolean
  | number
  | string
  | DateValue
  | readonly StableValue[]
  | { readonly [key: string]: StableValue };
