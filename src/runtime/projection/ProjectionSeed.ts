/**
 * Restart-safe anchor/row-binding seed for cutover.
 *
 * Seeding is intentionally explicit about whether a row already has a known
 * canonical entity.  An arbitrary Sheet row is never silently promoted to
 * canonical authority merely because it has an anchor.
 */

import { stableHash, type FieldOwnership, type NormalizedCell } from "../../core/index.js";
import {
  isFencingValid,
  requireRegisteredSyncSheet,
  withImmediateTransaction,
  type DatabaseSyncLike,
  type FencingContext,
} from "../../storage/index.js";

/** One anchored projection row imported during cutover. */
export interface ProjectionSeedRow {
  readonly physicalAnchor: string;
  readonly physicalRowLocator: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  /** Omit entity ID to seed an observation-only candidate binding. */
  readonly entityId?: string;
  readonly entityRevision?: number;
  readonly fieldOwnership?: Readonly<Record<string, FieldOwnership>>;
}

/** Input for an idempotent seed pass over one registered physical projection. */
export interface ProjectionSeedInput {
  readonly physicalSheetId: string;
  readonly rows: readonly ProjectionSeedRow[];
  readonly acceptedSnapshotHash: string;
}

/** Result retained by cutover as a stable seed checkpoint. */
export type ProjectionSeedResult =
  | { readonly kind: "fenced_out" }
  | {
      readonly kind: "seeded";
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
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
  const registration = requireRegisteredSyncSheet(db, input.physicalSheetId);
  return withImmediateTransaction(db, () => {
    if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
    let candidateRows = 0;
    let activeRows = 0;
    for (const row of input.rows) {
      const rowBindingId = seedRowBindingId(registration.logicalSheetId, row.physicalAnchor);
      if (row.entityId === undefined) candidateRows += 1;
      else activeRows += 1;
      seedBinding(db, registration.logicalSheetId, rowBindingId, row);
      seedProjectionBinding(db, registration.physicalSheetId, rowBindingId, row);
      seedVisibleBaseline(db, registration.physicalSheetId, registration.projection, rowBindingId, row);
      if (row.entityId !== undefined) {
        seedCanonicalEntity(db, { ...row, entityId: row.entityId }, input.acceptedSnapshotHash);
      }
    }
    return {
      kind: "seeded",
      physicalSheetId: registration.physicalSheetId,
      seededRows: input.rows.length,
      candidateRows,
      activeRows,
      seedHash: stableHash({
        physicalSheetId: registration.physicalSheetId,
        acceptedSnapshotHash: input.acceptedSnapshotHash,
        rows: input.rows.map((row) => ({
          physicalAnchor: row.physicalAnchor,
          physicalRowLocator: row.physicalRowLocator,
          fields: normalizedFieldEntries(row.fields),
          entityId: row.entityId ?? null,
          entityRevision: row.entityRevision ?? null,
        })),
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
  const existing = db.prepare(`
    SELECT logical_sheet_id, anchor_reference, entity_id, state
    FROM row_binding WHERE row_binding_id = ?
  `).get(rowBindingId) as {
    logical_sheet_id: string;
    anchor_reference: string;
    entity_id: string | null;
    state: string;
  } | undefined;
  const state = row.entityId === undefined ? "candidate" : "active";
  if (existing === undefined) {
    const result = db.prepare(`
      INSERT INTO row_binding (
        row_binding_id, logical_sheet_id, anchor_reference, entity_id, state
      ) VALUES (?, ?, ?, ?, ?)
    `).run(rowBindingId, logicalSheetId, row.physicalAnchor, row.entityId ?? null, state);
    if (result.changes !== 1) throw new Error("could not seed row binding");
    return;
  }
  if (
    existing.logical_sheet_id !== logicalSheetId ||
    existing.anchor_reference !== row.physicalAnchor ||
    existing.entity_id !== (row.entityId ?? null) ||
    existing.state !== state
  ) {
    throw new Error("seed row binding does not match an existing binding");
  }
}

function seedProjectionBinding(
  db: DatabaseSyncLike,
  physicalSheetId: string,
  rowBindingId: string,
  row: ProjectionSeedRow,
): void {
  const existing = db.prepare(`
    SELECT row_binding_id, conflict_id, anchor_reference, physical_row_locator
    FROM projection_row_binding
    WHERE physical_sheet_id = ? AND anchor_reference = ?
  `).get(physicalSheetId, row.physicalAnchor) as {
    row_binding_id: string | null;
    conflict_id: string | null;
    anchor_reference: string;
    physical_row_locator: number | null;
  } | undefined;
  if (existing === undefined) {
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
    if (result.changes !== 1) throw new Error("could not seed projection row binding");
    return;
  }
  if (
    existing.row_binding_id !== rowBindingId ||
    existing.conflict_id !== null ||
    existing.physical_row_locator !== row.physicalRowLocator
  ) {
    throw new Error("seed projection anchor does not match an existing projection binding");
  }
}

function seedVisibleBaseline(
  db: DatabaseSyncLike,
  physicalSheetId: string,
  projection: string,
  rowBindingId: string,
  row: ProjectionSeedRow,
): void {
  const rowHash = visibleHash(row.fields);
  const existing = db.prepare(`
    SELECT confirmed_snapshot_hash, confirmed_visible_revision
    FROM sheet_visible_state
    WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
  `).get(physicalSheetId, projection, rowBindingId) as {
    confirmed_snapshot_hash: string;
    confirmed_visible_revision: number;
  } | undefined;
  if (existing === undefined) {
    db.prepare(`
      INSERT INTO sheet_visible_state (
        physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash,
        confirmed_visible_revision, confirmed_entity_revision, last_observed_hash
      ) VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(physicalSheetId, projection, rowBindingId, rowHash, row.entityRevision ?? null, rowHash);
  } else if (existing.confirmed_snapshot_hash !== rowHash || existing.confirmed_visible_revision !== 0) {
    throw new Error("seed visible baseline does not match an existing confirmed projection row");
  }
  for (const [fieldName, value] of Object.entries(row.fields)) {
    const hash = stableHash(value);
    const field = db.prepare(`
      SELECT confirmed_field_hash, confirmed_visible_revision
      FROM sheet_visible_field_state
      WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ? AND field_name = ?
    `).get(physicalSheetId, projection, rowBindingId, fieldName) as {
      confirmed_field_hash: string;
      confirmed_visible_revision: number;
    } | undefined;
    if (field === undefined) {
      db.prepare(`
        INSERT INTO sheet_visible_field_state (
          physical_sheet_id, projection, row_binding_id, field_name,
          confirmed_field_hash, confirmed_visible_revision, candidate_epoch,
          last_observed_field_hash
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
      `).run(physicalSheetId, projection, rowBindingId, fieldName, hash, hash);
    } else if (field.confirmed_field_hash !== hash || field.confirmed_visible_revision !== 0) {
      throw new Error("seed visible field baseline does not match an existing field");
    }
  }
}

function seedCanonicalEntity(
  db: DatabaseSyncLike,
  row: ProjectionSeedRow & { readonly entityId: string },
  acceptedSnapshotHash: string,
): void {
  const revision = row.entityRevision ?? 1;
  const entity = db.prepare(`
    SELECT entity_revision, accepted_snapshot_hash, status
    FROM entity_state WHERE entity_id = ?
  `).get(row.entityId) as {
    entity_revision: number;
    accepted_snapshot_hash: string | null;
    status: string;
  } | undefined;
  if (entity === undefined) {
    db.prepare(`
      INSERT INTO entity_state (entity_id, entity_revision, accepted_snapshot_hash, status)
      VALUES (?, ?, ?, 'active')
    `).run(row.entityId, revision, acceptedSnapshotHash);
  } else if (
    entity.entity_revision !== revision ||
    entity.accepted_snapshot_hash !== acceptedSnapshotHash ||
    entity.status !== "active"
  ) {
    throw new Error("seed entity does not match existing canonical state");
  }
  for (const [fieldName, value] of Object.entries(row.fields)) {
    const ownership = row.fieldOwnership?.[fieldName] ?? "user";
    const serialized = JSON.stringify(value);
    const field = db.prepare(`
      SELECT normalized_value, field_revision, ownership
      FROM entity_field_state WHERE entity_id = ? AND field_name = ?
    `).get(row.entityId, fieldName) as {
      normalized_value: string;
      field_revision: number;
      ownership: string;
    } | undefined;
    if (field === undefined) {
      db.prepare(`
        INSERT INTO entity_field_state (
          entity_id, field_name, normalized_value, field_revision, ownership
        ) VALUES (?, ?, ?, 1, ?)
      `).run(row.entityId, fieldName, serialized, ownership);
    } else if (field.normalized_value !== serialized || field.field_revision !== 1 || field.ownership !== ownership) {
      throw new Error("seed canonical field does not match existing canonical state");
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
  if (input.physicalSheetId.length === 0 || input.acceptedSnapshotHash.length === 0) {
    throw new Error("projection seed physical sheet ID and snapshot hash are required");
  }
  const anchors = new Set<string>();
  for (const row of input.rows) {
    if (row.physicalAnchor.length === 0 || !Number.isSafeInteger(row.physicalRowLocator) ||
      row.physicalRowLocator < 2 || anchors.has(row.physicalAnchor)) {
      throw new Error("projection seed rows require unique non-empty anchors and locators");
    }
    anchors.add(row.physicalAnchor);
    if (Object.keys(row.fields).length === 0) throw new Error("projection seed row must contain fields");
    if (row.entityId === undefined && row.entityRevision !== undefined) {
      throw new Error("candidate projection seed cannot declare an entity revision");
    }
    if (row.entityId !== undefined && (
      row.entityId.length === 0 ||
      (row.entityRevision !== undefined && (!Number.isSafeInteger(row.entityRevision) || row.entityRevision < 1))
    )) {
      throw new Error("active projection seed has an invalid entity identity or revision");
    }
  }
}
