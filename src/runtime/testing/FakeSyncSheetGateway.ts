/**
 * In-memory implementation of the sync gateway contract.
 *
 * It deliberately models only the safety boundary: anchor identity, visible
 * compare-and-set, effect-id receipts, read-back after response loss, and
 * bounded partial batches.  Tests can therefore prove outbox behavior without
 * a network call or a Google Sheet.
 */

import { stableHash, type NormalizedCell } from "../../core/index.js";
import {
  computeSyncVisibleHash,
  type ApplySyncEffectsRequest,
  type ApplySyncEffectsResult,
  type EnsureSyncRowAnchorsRequest,
  type EnsureSyncRowAnchorsResult,
  type ReadSyncSnapshotRequest,
  type SyncEffectPostcondition,
  type SyncGatewayEffect,
  type SyncGatewayEffectResult,
  type SyncGatewaySnapshot,
  type SyncProjection,
  type SyncSheetGateway,
  type SyncSnapshotCell,
  type SyncSnapshotRow,
} from "../gateway/syncGateway.js";

/** Initial state for one fake projection row. */
export interface FakeSyncRowInput {
  readonly targetId: string;
  readonly physicalAnchor?: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly visibleRevision?: number;
  readonly activeCandidateHash?: string | null;
}

/** Initial state for one registered fake projection sheet. */
export interface FakeSyncSheetInput {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly rows?: readonly FakeSyncRowInput[];
}

/** Optional deterministic fault controls for a fake gateway. */
export interface FakeSyncGatewayOptions {
  /** Return only this many results per apply call, after applying that prefix. */
  readonly maxEffectsPerApply?: number;
}

interface FakeRow {
  readonly targetId: string;
  readonly anchor: string;
  fields: Record<string, NormalizedCell>;
  visibleRevision: number;
  visibleHash: string;
  activeCandidateHash: string | null;
}

interface FakeSheet {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly rowsByAnchor: Map<string, FakeRow>;
}

interface Receipt {
  readonly payloadHash: string;
  readonly targetVisibleHash: string;
  readonly visibleRevision: number;
}

/** Error intentionally thrown after a remote write has already completed. */
export class FakeSyncResponseLossError extends Error {
  public constructor() {
    super("Fake gateway dropped the response after applying remote effects.");
    this.name = "FakeSyncResponseLossError";
  }
}

/**
 * Fake gateway with explicit response-loss and partial-batch injection.
 *
 * `dropNextResponseAfterApply()` is intentionally one-shot: the next call
 * writes and records receipts before its caller observes a transport failure.
 */
export class FakeSyncSheetGateway implements SyncSheetGateway {
  private readonly sheets = new Map<string, FakeSheet>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly maxEffectsPerApply: number | null;
  private anchorSequence = 0;
  private dropResponse = false;

  public constructor(inputs: readonly FakeSyncSheetInput[], options: FakeSyncGatewayOptions = {}) {
    if (options.maxEffectsPerApply !== undefined && (
      !Number.isSafeInteger(options.maxEffectsPerApply) || options.maxEffectsPerApply < 1
    )) {
      throw new Error("maxEffectsPerApply must be a positive safe integer");
    }
    this.maxEffectsPerApply = options.maxEffectsPerApply ?? null;
    for (const input of inputs) this.addSheet(input);
  }

  /** Injects exactly one transport failure after the next successful remote apply. */
  public dropNextResponseAfterApply(): void {
    this.dropResponse = true;
  }

  /** Simulates a user/collaborator edit without creating an effect receipt. */
  public mutateRow(
    physicalSheetId: string,
    anchor: string,
    fields: Readonly<Record<string, NormalizedCell>>,
    activeCandidateHash: string | null = null,
  ): void {
    const sheet = this.requireSheet(physicalSheetId);
    const row = sheet.rowsByAnchor.get(anchor);
    if (row === undefined) throw new Error("fake row anchor does not exist: " + anchor);
    row.fields = { ...fields };
    row.visibleHash = computeSyncVisibleHash(row.fields);
    row.visibleRevision += 1;
    row.activeCandidateHash = activeCandidateHash;
  }

  /** Simulates a structural row disappearance without asserting delete evidence. */
  public removeRow(physicalSheetId: string, anchor: string): void {
    const sheet = this.requireSheet(physicalSheetId);
    if (!sheet.rowsByAnchor.delete(anchor)) {
      throw new Error("fake row anchor does not exist: " + anchor);
    }
  }

  /** Returns a copy of a fake row for assertions without exposing mutable state. */
  public readRow(physicalSheetId: string, anchor: string): FakeSyncRowInput & { readonly visibleHash: string } {
    const row = this.requireSheet(physicalSheetId).rowsByAnchor.get(anchor);
    if (row === undefined) throw new Error("fake row anchor does not exist: " + anchor);
    return {
      targetId: row.targetId,
      physicalAnchor: row.anchor,
      fields: { ...row.fields },
      visibleRevision: row.visibleRevision,
      activeCandidateHash: row.activeCandidateHash,
      visibleHash: row.visibleHash,
    };
  }

  public async ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    const sheet = this.requireMatchingSheet(request);
    const grouped = groupDuplicateAnchors([...sheet.rowsByAnchor.values()].map((row) => row.anchor));
    return {
      assigned: 0,
      existing: sheet.rowsByAnchor.size,
      duplicateAnchors: grouped,
    };
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    const sheet = this.requireMatchingSheet(request);
    const rows = [...sheet.rowsByAnchor.values()]
      .sort((left, right) => left.anchor.localeCompare(right.anchor))
      .map((row, index) => this.toSnapshotRow(sheet, row, index + 2));
    const snapshotPayload = {
      protocolVersion: "typed-sheets-sync-fake-v1",
      sheetName: sheet.sheetName,
      registeredRange: sheet.registeredRange,
      projection: sheet.projection,
      schemaVersion: sheet.schemaVersion,
      headers: sheet.headers,
      rows,
    };
    return {
      ...snapshotPayload,
      snapshotHash: stableHash({
        protocolVersion: snapshotPayload.protocolVersion,
        sheetName: snapshotPayload.sheetName,
        registeredRange: snapshotPayload.registeredRange,
        projection: snapshotPayload.projection,
        schemaVersion: snapshotPayload.schemaVersion,
        headers: [...snapshotPayload.headers],
        rows: rows.map((row) => ({
          rowNumber: row.rowNumber,
          physicalAnchor: row.physicalAnchor,
          visibleRevision: row.visibleRevision,
          visibleHash: row.visibleHash,
          cells: Object.fromEntries(Object.entries(row.cells).map(([fieldName, cell]) => [
            fieldName,
            cell.normalizedCell,
          ])),
        })),
      }),
      unanchoredRows: [],
      duplicateAnchors: groupDuplicateAnchors(rows.map((row) => row.physicalAnchor ?? "")),
    };
  }

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    const sheet = this.requireMatchingSheet(request);
    const limit = this.maxEffectsPerApply ?? request.effects.length;
    const selected = request.effects.slice(0, limit);
    const results = selected.map((effect) => this.applyOne(sheet, effect));
    const snapshotHash = this.sheetSnapshotHash(sheet);
    if (this.dropResponse) {
      this.dropResponse = false;
      throw new FakeSyncResponseLossError();
    }
    return { results, snapshotHash, hasMore: selected.length < request.effects.length };
  }

  public async readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    const sheet = this.sheets.get(effect.physicalSheetId);
    if (sheet === undefined) {
      return { disposition: "unavailable", visibleRevision: null, visibleHash: null, snapshotHash: null };
    }
    const row = sheet.rowsByAnchor.get(effect.payload.targetAnchor);
    const snapshotHash = this.sheetSnapshotHash(sheet);
    if (effect.effectKind === "resolution_delete") {
      const receipt = this.receipts.get(effect.effectId);
      if (receipt !== undefined && receipt.payloadHash !== effect.payloadHash) {
        return { disposition: "changed", visibleRevision: null, visibleHash: null, snapshotHash };
      }
      if (receipt !== undefined && row === undefined) {
        return {
          disposition: "applied",
          visibleRevision: receipt.visibleRevision,
          visibleHash: receipt.targetVisibleHash,
          snapshotHash,
        };
      }
      // An absent row without this effect's receipt could be a manual deletion.
      // Never let that absence close an outbox effect after response loss.
      if (row === undefined) {
        return { disposition: "unavailable", visibleRevision: null, visibleHash: null, snapshotHash };
      }
      const base = {
        visibleRevision: row.visibleRevision,
        visibleHash: row.visibleHash,
        snapshotHash,
      };
      if (receipt !== undefined) return { disposition: "changed", ...base };
      if (row.visibleRevision === effect.expectedVisibleRevision && row.visibleHash === effect.expectedVisibleHash) {
        return { disposition: "unapplied", ...base };
      }
      return { disposition: "changed", ...base };
    }
    if (row === undefined) {
      return {
        disposition: effect.payload.createIfMissing ? "unapplied" : "changed",
        visibleRevision: null,
        visibleHash: null,
        snapshotHash,
      };
    }
    const base = {
      visibleRevision: row.visibleRevision,
      visibleHash: row.visibleHash,
      snapshotHash,
    };
    if (row.visibleHash === effect.payload.targetVisibleHash) return { disposition: "applied", ...base };
    if (row.visibleHash === effect.expectedVisibleHash) return { disposition: "unapplied", ...base };
    if (effect.effectKind === "system_repair" && row.visibleHash === effect.repairGuardHash) {
      return { disposition: "unapplied", ...base };
    }
    return { disposition: "changed", ...base };
  }

  private addSheet(input: FakeSyncSheetInput): void {
    if (this.sheets.has(input.physicalSheetId)) {
      throw new Error("duplicate fake physical sheet ID: " + input.physicalSheetId);
    }
    if (input.headers.length === 0) throw new Error("fake sheet must contain headers");
    const rowsByAnchor = new Map<string, FakeRow>();
    for (const initial of input.rows ?? []) {
      const anchor = initial.physicalAnchor ?? this.nextAnchor();
      if (rowsByAnchor.has(anchor)) throw new Error("duplicate fake physical anchor: " + anchor);
      const fields = { ...initial.fields };
      rowsByAnchor.set(anchor, {
        targetId: initial.targetId,
        anchor,
        fields,
        visibleRevision: initial.visibleRevision ?? 0,
        visibleHash: computeSyncVisibleHash(fields),
        activeCandidateHash: initial.activeCandidateHash ?? null,
      });
    }
    this.sheets.set(input.physicalSheetId, {
      physicalSheetId: input.physicalSheetId,
      sheetName: input.sheetName,
      registeredRange: input.registeredRange,
      projection: input.projection,
      schemaVersion: input.schemaVersion,
      headers: [...input.headers],
      rowsByAnchor,
    });
  }

  private applyOne(sheet: FakeSheet, effect: SyncGatewayEffect): SyncGatewayEffectResult {
    if (effect.physicalSheetId !== sheet.physicalSheetId || effect.projection !== sheet.projection) {
      return this.result(effect, "schema_error", null, "effect targets a different fake sheet");
    }
    if (effect.payload.sheetName !== sheet.sheetName ||
      effect.payload.registeredRange !== sheet.registeredRange ||
      effect.payload.schemaVersion !== sheet.schemaVersion) {
      return this.result(effect, "schema_error", null, "effect payload does not match registered sheet");
    }
    if (computeSyncVisibleHash(effect.payload.fields) !== effect.payload.targetVisibleHash) {
      return this.result(effect, "schema_error", null, "effect target hash does not match fields");
    }
    const deletionShapeError = this.resolutionDeleteShapeError(sheet, effect);
    if (deletionShapeError !== null) {
      return this.result(effect, "schema_error", null, deletionShapeError);
    }

    const receipt = this.receipts.get(effect.effectId);
    if (receipt !== undefined) {
      if (receipt.payloadHash !== effect.payloadHash) {
        return this.result(effect, "schema_error", null, "effect ID was reused with another payload");
      }
      const row = sheet.rowsByAnchor.get(effect.payload.targetAnchor) ?? null;
      if (effect.effectKind === "resolution_delete") {
        if (row === null) return this.result(effect, "already_applied", null, null, receipt);
        return this.result(effect, "guard_mismatch", row, "receipt_target_reappeared");
      }
      if (row === null || row.visibleRevision !== receipt.visibleRevision ||
        row.visibleHash !== receipt.targetVisibleHash ||
        row.visibleHash !== effect.payload.targetVisibleHash) {
        return this.result(
          effect,
          effect.effectKind === "system_repair" ? "repair_reobserve" : "guard_mismatch",
          row,
          "receipt_postcondition_changed",
        );
      }
      return this.result(effect, "already_applied", row, null);
    }

    let row = sheet.rowsByAnchor.get(effect.payload.targetAnchor) ?? null;
    if (row === null) {
      if (!effect.payload.createIfMissing) {
        return this.result(effect, "guard_mismatch", null, "target anchor is missing");
      }
      if (effect.expectedVisibleRevision !== 0 || effect.expectedVisibleHash !== "") {
        return this.result(effect, "guard_mismatch", null, "insert requires an empty visible baseline");
      }
      row = {
        targetId: effect.targetId,
        anchor: effect.payload.targetAnchor,
        fields: {},
        visibleRevision: 0,
        visibleHash: "",
        activeCandidateHash: null,
      };
      sheet.rowsByAnchor.set(row.anchor, row);
    }

    if (effect.effectKind === "resolution_delete") {
      if (row.visibleRevision !== effect.expectedVisibleRevision || row.visibleHash !== effect.expectedVisibleHash) {
        return this.result(effect, "guard_mismatch", row, "visible_guard_mismatch");
      }
      const deletionReceipt: Receipt = {
        payloadHash: effect.payloadHash,
        targetVisibleHash: effect.payload.targetVisibleHash,
        visibleRevision: row.visibleRevision,
      };
      sheet.rowsByAnchor.delete(row.anchor);
      this.receipts.set(effect.effectId, deletionReceipt);
      return this.result(effect, "applied", null, null, deletionReceipt);
    }

    if (effect.effectKind === "candidate_reconcile" && row.activeCandidateHash !== null) {
      if (effect.payload.expectedCandidateHash !== row.activeCandidateHash) {
        return this.result(effect, "guard_mismatch", row, "candidate_guard_mismatch");
      }
      return this.result(effect, "guard_mismatch", row, "active_candidate_preserved");
    }

    if (row.visibleHash === effect.payload.targetVisibleHash) {
      this.receipts.set(effect.effectId, {
        payloadHash: effect.payloadHash,
        targetVisibleHash: effect.payload.targetVisibleHash,
        visibleRevision: row.visibleRevision,
      });
      return this.result(effect, "already_applied", row, null);
    }

    if (effect.effectKind === "system_repair") {
      if (effect.repairGuardHash === null || row.visibleHash !== effect.repairGuardHash) {
        return this.result(effect, "repair_reobserve", row, "repair_guard_mismatch");
      }
    } else if (
      row.visibleRevision !== effect.expectedVisibleRevision ||
      row.visibleHash !== effect.expectedVisibleHash
    ) {
      return this.result(effect, "guard_mismatch", row, "visible_guard_mismatch");
    }

    row.fields = { ...effect.payload.fields };
    row.visibleHash = effect.payload.targetVisibleHash;
    row.visibleRevision += 1;
    if (effect.effectKind === "resolution_projection") row.activeCandidateHash = null;
    this.receipts.set(effect.effectId, {
      payloadHash: effect.payloadHash,
      targetVisibleHash: effect.payload.targetVisibleHash,
      visibleRevision: row.visibleRevision,
    });
    return this.result(effect, "applied", row, null);
  }

  /** Rejects broad or ambiguous delete effects before an anchor is ever removed. */
  private resolutionDeleteShapeError(sheet: FakeSheet, effect: SyncGatewayEffect): string | null {
    if (effect.effectKind !== "resolution_delete") return null;
    if (
      effect.projection !== "sync_conflicts" || effect.payload.createIfMissing ||
      effect.expectedVisibleRevision < 1 || effect.payload.targetVisibleHash !== effect.expectedVisibleHash
    ) {
      return "invalid_resolution_delete_guard";
    }
    const actualFields = Object.keys(effect.payload.fields).sort();
    const expectedFields = [...sheet.headers].sort();
    if (
      actualFields.length !== expectedFields.length ||
      actualFields.some((fieldName, index) => fieldName !== expectedFields[index])
    ) {
      return "resolution_delete_requires_full_row";
    }
    return null;
  }

  private result(
    effect: SyncGatewayEffect,
    status: SyncGatewayEffectResult["status"],
    row: FakeRow | null,
    reason: string | null,
    receipt?: Receipt,
  ): SyncGatewayEffectResult {
    const sheet = this.sheets.get(effect.physicalSheetId);
    return {
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      status,
      visibleRevision: receipt?.visibleRevision ?? (row === null ? null : row.visibleRevision),
      visibleHash: receipt?.targetVisibleHash ?? (row === null ? null : row.visibleHash),
      snapshotHash: sheet === undefined ? null : this.sheetSnapshotHash(sheet),
      reason,
      postcondition: receipt !== undefined || row !== null ? "verified" : "unavailable",
    };
  }

  private toSnapshotRow(sheet: FakeSheet, row: FakeRow, rowNumber: number): SyncSnapshotRow {
    const cells: Record<string, SyncSnapshotCell> = {};
    for (const header of sheet.headers) {
      const value = row.fields[header] ?? null;
      cells[header] = value === null
        ? {
          cellKind: "blank",
          normalizedCell: null,
          formulaHash: null,
          mergeRange: null,
          errorCode: null,
          stableHash: stableHash(null),
        }
        : {
          cellKind: "literal",
          normalizedCell: value,
          formulaHash: null,
          mergeRange: null,
          errorCode: null,
          stableHash: stableHash(value),
        };
    }
    return {
      rowNumber,
      physicalAnchor: row.anchor,
      visibleRevision: row.visibleRevision,
      visibleHash: row.visibleHash,
      cells,
    };
  }

  private requireSheet(physicalSheetId: string): FakeSheet {
    const sheet = this.sheets.get(physicalSheetId);
    if (sheet === undefined) throw new Error("unknown fake physical sheet: " + physicalSheetId);
    return sheet;
  }

  private requireMatchingSheet(request: EnsureSyncRowAnchorsRequest): FakeSheet {
    const sheet = this.requireSheet(request.physicalSheetId);
    if (
      sheet.sheetName !== request.sheetName ||
      sheet.registeredRange !== request.registeredRange ||
      sheet.projection !== request.projection ||
      sheet.schemaVersion !== request.schemaVersion
    ) {
      throw new Error("fake gateway request does not match registered sheet");
    }
    return sheet;
  }

  private sheetSnapshotHash(sheet: FakeSheet): string {
    return stableHash({
      sheetName: sheet.sheetName,
      registeredRange: sheet.registeredRange,
      projection: sheet.projection,
      schemaVersion: sheet.schemaVersion,
      rows: [...sheet.rowsByAnchor.values()]
        .sort((left, right) => left.anchor.localeCompare(right.anchor))
        .map((row) => ({
          targetId: row.targetId,
          anchor: row.anchor,
          fields: row.fields,
          visibleRevision: row.visibleRevision,
          visibleHash: row.visibleHash,
          activeCandidateHash: row.activeCandidateHash,
        })),
    });
  }

  private nextAnchor(): string {
    this.anchorSequence += 1;
    return "fake-anchor:" + this.anchorSequence;
  }
}

function groupDuplicateAnchors(anchors: readonly string[]): readonly {
  readonly anchor: string;
  readonly rowNumbers: readonly number[];
}[] {
  const grouped = new Map<string, number[]>();
  anchors.forEach((anchor, index) => {
    const rows = grouped.get(anchor) ?? [];
    rows.push(index + 2);
    grouped.set(anchor, rows);
  });
  return [...grouped.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([anchor, rowNumbers]) => ({ anchor, rowNumbers }));
}
