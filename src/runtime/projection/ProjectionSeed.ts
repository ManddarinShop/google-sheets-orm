/**
 * Restart-safe anchor/row-binding seed for cutover.
 *
 * Seeding is intentionally explicit about whether a row already has a known
 * canonical entity. An arbitrary Sheet row is never silently promoted to
 * canonical authority merely because it has an anchor.
 */

import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type Applicability,
  type FieldOwnership,
  type LookupResult,
  type NormalizedCell,
  type Presence,
  type StableValue,
} from "../../core/index.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../core/state/index.js";
import {
  FIELD_OWNERSHIPS,
  ROW_BINDING_STATES,
} from "../../core/model/constants.js";
import {
  isFencingValid,
  requireRegisteredSyncSheet,
  withImmediateTransaction,
  type DatabaseSyncLike,
  type FencingContext,
  type RegisteredProjection,
} from "../../storage/index.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../storage/errors.js";
import { EXPECTED_SINGLE_ROW_CHANGE_COUNT } from "../../storage/constants.js";
import { fromSqlNullable, toSqlNullable } from "../../storage/sqlite/sqlState.js";

const FIRST_DATA_ROW_NUMBER = 2 as const;
const DEFAULT_ENTITY_REVISION = POSITIVE_SAFE_INTEGER_MINIMUM;
const DEFAULT_FIELD_OWNERSHIP = FIELD_OWNERSHIPS.USER;
const CANONICAL_ENTITY_STATUSES = {
  ACTIVE: "active",
} as const;

/** Runtime result kinds returned by one projection seed pass. */
export const PROJECTION_SEED_RESULT_KINDS = {
  FENCED_OUT: "fenced_out",
  SEEDED: "seeded",
} as const;

export type ProjectionSeedResultKind =
  (typeof PROJECTION_SEED_RESULT_KINDS)[keyof typeof PROJECTION_SEED_RESULT_KINDS];

const PROJECTION_SEED_ROW_KINDS = {
  CANDIDATE: "candidate",
  ACTIVE: "active",
} as const;

/** Shared input fields for one anchored projection row. */
interface ProjectionSeedRowBase {
  readonly physicalAnchor: string;
  readonly physicalRowLocator: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly fieldOwnership?: Readonly<Record<string, FieldOwnership>>;
}

/** A row that has not yet been linked to a canonical entity. */
export interface ProjectionSeedCandidateRow extends ProjectionSeedRowBase {
  readonly entityId?: never;
  readonly entityRevision?: never;
}

/** A row whose existing canonical entity is known during cutover. */
export interface ProjectionSeedActiveRow extends ProjectionSeedRowBase {
  readonly entityId: string;
  readonly entityRevision?: number;
}

/** One anchored projection row imported during cutover. */
export type ProjectionSeedRow =
  | ProjectionSeedCandidateRow
  | ProjectionSeedActiveRow;

/** Input for an idempotent seed pass over one registered physical projection. */
export interface ProjectionSeedInput {
  readonly physicalSheetId: string;
  readonly rows: readonly ProjectionSeedRow[];
  readonly acceptedSnapshotHash: string;
}

/** Result retained by cutover as a stable seed checkpoint. */
export type ProjectionSeedResult =
  | { readonly kind: typeof PROJECTION_SEED_RESULT_KINDS.FENCED_OUT }
  | {
      readonly kind: typeof PROJECTION_SEED_RESULT_KINDS.SEEDED;
      readonly physicalSheetId: string;
      readonly seededRows: number;
      readonly candidateRows: number;
      readonly activeRows: number;
      readonly seedHash: string;
    };

/**
 * Seeds projection-local anchor bindings and visible baselines atomically.
 *
 * A repeat with identical anchor/entity/field facts is a no-op. Any mismatch
 * fails closed rather than overwriting a prior binding, entity revision, or
 * confirmed field hash during a resumed cutover.
 */
export function seedProjectionRows(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: ProjectionSeedInput,
): ProjectionSeedResult {
  validateInput(input);
  if (!isFencingValid(db, fence)) return fencedOutResult();
  const registration = requireRegisteredSyncSheet(db, input.physicalSheetId);
  return withImmediateTransaction(db, () => {
    if (!isFencingValid(db, fence)) return fencedOutResult();
    let candidateRows = 0;
    let activeRows = 0;
    for (const row of input.rows) {
      const rowBindingId = seedRowBindingId(registration.logicalSheetId, row.physicalAnchor);
      if (row.entityId === undefined) candidateRows += 1;
      else activeRows += 1;
      seedBinding(db, registration.logicalSheetId, rowBindingId, row);
      seedProjectionBinding(db, registration.physicalSheetId, rowBindingId, row);
      seedVisibleBaseline(
        db,
        registration.physicalSheetId,
        registration.projection,
        rowBindingId,
        row,
      );
      if (row.entityId !== undefined) {
        seedCanonicalEntity(db, row, input.acceptedSnapshotHash);
      }
    }
    return {
      kind: PROJECTION_SEED_RESULT_KINDS.SEEDED,
      physicalSheetId: registration.physicalSheetId,
      seededRows: input.rows.length,
      candidateRows,
      activeRows,
      seedHash: stableHash({
        physicalSheetId: registration.physicalSheetId,
        acceptedSnapshotHash: input.acceptedSnapshotHash,
        rows: input.rows.map(seedHashRow),
      }),
    };
  });
}

/** Deterministic binding IDs make the same anchor seed restart-safe. */
export function seedRowBindingId(logicalSheetId: string, physicalAnchor: string): string {
  return "binding:" + stableHash({ logicalSheetId, physicalAnchor });
}

function seedBinding(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  rowBindingId: string,
  row: ProjectionSeedRow,
): void {
  const existing = lookupResult(db.prepare(`
    SELECT logical_sheet_id, anchor_reference, entity_id, state
    FROM row_binding WHERE row_binding_id = ?
  `).get(rowBindingId) as RowBindingSqlRow | undefined);
  const entityId = row.entityId === undefined
    ? absentValue<string>()
    : presentValue(row.entityId);
  const state = row.entityId === undefined
    ? ROW_BINDING_STATES.CANDIDATE
    : ROW_BINDING_STATES.ACTIVE;
  if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
    const result = db.prepare(`
      INSERT INTO row_binding (
        row_binding_id, logical_sheet_id, anchor_reference, entity_id, state
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      rowBindingId,
      logicalSheetId,
      row.physicalAnchor,
      toSqlNullable(entityId),
      state,
    );
    requireSingleChange(result.changes, "could not seed row binding");
    return;
  }
  const existingRow = existing.value;
  if (
    existingRow.logical_sheet_id !== logicalSheetId ||
    existingRow.anchor_reference !== row.physicalAnchor ||
    !samePresence(fromSqlNullable(existingRow.entity_id), entityId) ||
    existingRow.state !== state
  ) {
    throwSeedConflict("seed row binding does not match an existing binding");
  }
}

function seedProjectionBinding(
  db: DatabaseSyncLike,
  physicalSheetId: string,
  rowBindingId: string,
  row: ProjectionSeedRow,
): void {
  const existing = lookupResult(db.prepare(`
    SELECT row_binding_id, conflict_id, anchor_reference, physical_row_locator
    FROM projection_row_binding
    WHERE physical_sheet_id = ? AND anchor_reference = ?
  `).get(physicalSheetId, row.physicalAnchor) as ProjectionBindingSqlRow | undefined);
  if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
    const result = db.prepare(`
      INSERT INTO projection_row_binding (
        projection_row_id, physical_sheet_id, row_binding_id, conflict_id,
        anchor_reference, physical_row_locator
      ) VALUES (?, ?, ?, NULL, ?, ?)
    `).run(
      "projection-row:" + stableHash({ physicalSheetId, rowBindingId, anchor: row.physicalAnchor }),
      physicalSheetId,
      rowBindingId,
      row.physicalAnchor,
      row.physicalRowLocator,
    );
    requireSingleChange(result.changes, "could not seed projection row binding");
    return;
  }
  const existingRow = existing.value;
  if (
    !samePresence(fromSqlNullable(existingRow.row_binding_id), presentValue(rowBindingId)) ||
    !samePresence(fromSqlNullable(existingRow.conflict_id), absentValue<string>()) ||
    !samePresence(fromSqlNullable(existingRow.physical_row_locator), presentValue(row.physicalRowLocator))
  ) {
    throwSeedConflict("seed projection anchor does not match an existing projection binding");
  }
}

function seedVisibleBaseline(
  db: DatabaseSyncLike,
  physicalSheetId: string,
  projection: RegisteredProjection,
  rowBindingId: string,
  row: ProjectionSeedRow,
): void {
  const rowHash = visibleHash(row.fields);
  const entityRevision = row.entityId === undefined
    ? notApplicableValue<number>()
    : applicableValue(row.entityRevision ?? DEFAULT_ENTITY_REVISION);
  const existing = lookupResult(db.prepare(`
    SELECT confirmed_snapshot_hash, confirmed_visible_revision
    FROM sheet_visible_state
    WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
  `).get(physicalSheetId, projection, rowBindingId) as VisibleStateSqlRow | undefined);
  if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
    db.prepare(`
      INSERT INTO sheet_visible_state (
        physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash,
        confirmed_visible_revision, confirmed_entity_revision, last_observed_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      physicalSheetId,
      projection,
      rowBindingId,
      rowHash,
      NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
      toSqlNullable(entityRevision),
      rowHash,
    );
  } else if (
    existing.value.confirmed_snapshot_hash !== rowHash ||
    existing.value.confirmed_visible_revision !== NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwSeedConflict("seed visible baseline does not match an existing confirmed projection row");
  }
  for (const [fieldName, value] of Object.entries(row.fields)) {
    const hash = stableHash(value);
    const field = lookupResult(db.prepare(`
      SELECT confirmed_field_hash, confirmed_visible_revision
      FROM sheet_visible_field_state
      WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ? AND field_name = ?
    `).get(physicalSheetId, projection, rowBindingId, fieldName) as VisibleFieldStateSqlRow | undefined);
    if (field.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      db.prepare(`
        INSERT INTO sheet_visible_field_state (
          physical_sheet_id, projection, row_binding_id, field_name,
          confirmed_field_hash, confirmed_visible_revision, candidate_epoch,
          last_observed_field_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        physicalSheetId,
        projection,
        rowBindingId,
        fieldName,
        hash,
        NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
        NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
        hash,
      );
    } else if (
      field.value.confirmed_field_hash !== hash ||
      field.value.confirmed_visible_revision !== NON_NEGATIVE_SAFE_INTEGER_MINIMUM
    ) {
      throwSeedConflict("seed visible field baseline does not match an existing field");
    }
  }
}

function seedCanonicalEntity(
  db: DatabaseSyncLike,
  row: ProjectionSeedActiveRow,
  acceptedSnapshotHash: string,
): void {
  const revision = row.entityRevision ?? DEFAULT_ENTITY_REVISION;
  const entity = lookupResult(db.prepare(`
    SELECT entity_revision, accepted_snapshot_hash, status
    FROM entity_state WHERE entity_id = ?
  `).get(row.entityId) as EntityStateSqlRow | undefined);
  if (entity.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
    db.prepare(`
      INSERT INTO entity_state (entity_id, entity_revision, accepted_snapshot_hash, status)
      VALUES (?, ?, ?, ?)
    `).run(row.entityId, revision, acceptedSnapshotHash, CANONICAL_ENTITY_STATUSES.ACTIVE);
  } else if (
    entity.value.entity_revision !== revision ||
    !samePresence(
      fromSqlNullable(entity.value.accepted_snapshot_hash),
      presentValue(acceptedSnapshotHash),
    ) ||
    entity.value.status !== CANONICAL_ENTITY_STATUSES.ACTIVE
  ) {
    throwSeedConflict("seed entity does not match existing canonical state");
  }
  for (const [fieldName, value] of Object.entries(row.fields)) {
    const ownership = row.fieldOwnership?.[fieldName] ?? DEFAULT_FIELD_OWNERSHIP;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throwSeedConflict(`could not serialize canonical field ${fieldName}`);
    }
    const field = lookupResult(db.prepare(`
      SELECT normalized_value, field_revision, ownership
      FROM entity_field_state WHERE entity_id = ? AND field_name = ?
    `).get(row.entityId, fieldName) as EntityFieldStateSqlRow | undefined);
    if (field.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      db.prepare(`
        INSERT INTO entity_field_state (
          entity_id, field_name, normalized_value, field_revision, ownership
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        row.entityId,
        fieldName,
        serialized,
        POSITIVE_SAFE_INTEGER_MINIMUM,
        ownership,
      );
    } else if (
      field.value.normalized_value !== serialized ||
      field.value.field_revision !== POSITIVE_SAFE_INTEGER_MINIMUM ||
      field.value.ownership !== ownership
    ) {
      throwSeedConflict("seed canonical field does not match existing canonical state");
    }
  }
}

function visibleHash(fields: Readonly<Record<string, NormalizedCell>>): string {
  return stableHash({ fields: normalizedFieldEntries(fields) });
}

function normalizedFieldEntries(fields: Readonly<Record<string, NormalizedCell>>): readonly {
  readonly fieldName: string;
  readonly value: NormalizedCell;
}[] {
  return Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldName, value]) => ({ fieldName, value }));
}

function validateInput(input: ProjectionSeedInput): void {
  requireNonEmptyText(input.physicalSheetId, "projection seed physical sheet ID");
  requireNonEmptyText(input.acceptedSnapshotHash, "projection seed accepted snapshot hash");
  const anchors = new Set<string>();
  for (const row of input.rows) {
    requireNonEmptyText(row.physicalAnchor, "projection seed physical anchor");
    if (
      !Number.isSafeInteger(row.physicalRowLocator) ||
      row.physicalRowLocator < FIRST_DATA_ROW_NUMBER ||
      anchors.has(row.physicalAnchor)
    ) {
      throwSeedInputError("projection seed rows require unique non-empty anchors and locators");
    }
    anchors.add(row.physicalAnchor);
    if (Object.keys(row.fields).length === 0) {
      throwSeedInputError("projection seed row must contain fields");
    }
    if (row.entityId === undefined) continue;
    requireNonEmptyText(row.entityId, "active projection seed entity ID");
    if (
      row.entityRevision !== undefined &&
      (!Number.isSafeInteger(row.entityRevision) ||
        row.entityRevision < POSITIVE_SAFE_INTEGER_MINIMUM)
    ) {
      throwSeedInputError("active projection seed has an invalid entity revision");
    }
  }
}

interface RowBindingSqlRow {
  readonly logical_sheet_id: string;
  readonly anchor_reference: string;
  readonly entity_id: string | null;
  readonly state: string;
}

interface ProjectionBindingSqlRow {
  readonly row_binding_id: string | null;
  readonly conflict_id: string | null;
  readonly anchor_reference: string;
  readonly physical_row_locator: number | null;
}

interface VisibleStateSqlRow {
  readonly confirmed_snapshot_hash: string;
  readonly confirmed_visible_revision: number;
}

interface VisibleFieldStateSqlRow {
  readonly confirmed_field_hash: string;
  readonly confirmed_visible_revision: number;
}

interface EntityStateSqlRow {
  readonly entity_revision: number;
  readonly accepted_snapshot_hash: string | null;
  readonly status: string;
}

interface EntityFieldStateSqlRow {
  readonly normalized_value: string;
  readonly field_revision: number;
  readonly ownership: string;
}

function seedHashRow(row: ProjectionSeedRow): StableValue {
  return {
    physicalAnchor: row.physicalAnchor,
    physicalRowLocator: row.physicalRowLocator,
    fields: normalizedFieldEntries(row.fields),
    identity: row.entityId === undefined
      ? { kind: PROJECTION_SEED_ROW_KINDS.CANDIDATE }
      : {
          kind: PROJECTION_SEED_ROW_KINDS.ACTIVE,
          entityId: row.entityId,
          entityRevision: row.entityRevision ?? DEFAULT_ENTITY_REVISION,
        },
  };
}

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function applicableValue<T>(value: T): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

function notApplicableValue<T>(): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };
}

function lookupResult<T>(value: T | undefined): LookupResult<T> {
  return value === undefined ? notFoundValue() : foundValue(value);
}

function foundValue<T>(value: T): LookupResult<T> {
  return { kind: LOOKUP_RESULT_KINDS.FOUND, value };
}

function notFoundValue<T>(): LookupResult<T> {
  return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
}

function samePresence<T>(left: Presence<T>, right: Presence<T>): boolean {
  if (left.kind !== right.kind) return false;
  if (
    left.kind === PRESENCE_KINDS.PRESENT &&
    right.kind === PRESENCE_KINDS.PRESENT
  ) {
    return left.value === right.value;
  }
  return true;
}

function requireNonEmptyText(value: string, label: string): void {
  if (value.length === 0) throwSeedInputError(`${label} is required`);
}

function requireSingleChange(changes: number, message: string): void {
  if (changes !== EXPECTED_SINGLE_ROW_CHANGE_COUNT) {
    throwSeedConflict(message);
  }
}

function throwSeedInputError(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PROJECTION_SEED, message);
}

function throwSeedConflict(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.PROJECTION_SEED_CONFLICT, message);
}

function fencedOutResult(): ProjectionSeedResult {
  return { kind: PROJECTION_SEED_RESULT_KINDS.FENCED_OUT };
}
