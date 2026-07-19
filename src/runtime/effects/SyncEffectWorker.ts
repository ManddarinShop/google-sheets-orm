/**
 * Fenced outbox worker for projection effects.
 *
 * It owns only claim/result transitions.  Canonical state and any repair
 * replan payload are supplied by the writer boundary; the gateway is never
 * allowed to choose a winner or silently retry a response-lost write.
 */

import { randomUUID } from "node:crypto";
import { stableHash } from "../../core/index.js";
import {
  applyEffectResult,
  claimEffect,
  claimWriterLease,
  listReadyEffects,
  releaseUnprocessedEffect,
  supersedeAndReplan,
  type DatabaseSyncLike,
  type FencingContext,
  type NewEffect,
  type PendingEffect,
  type WriterLease,
} from "../../storage/index.js";
import {
  parseSyncProjectionEffectPayload,
  type ApplySyncEffectsRequest,
  type SyncEffectPostcondition,
  type SyncGatewayEffect,
  type SyncGatewayEffectResult,
  type SyncProjection,
  type SyncSheetGateway,
} from "../gateway/syncGateway.js";

/** An effect plus evidence supplied to a writer-owned system-repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly gatewayResult: SyncGatewayEffectResult | null;
  readonly postcondition: SyncEffectPostcondition | null;
}

/** Callback that creates a fresh effect without mutating the old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => NewEffect | null;

/** Construction options for a bounded worker pass. */
export interface SyncEffectWorkerOptions {
  readonly database: DatabaseSyncLike;
  readonly gateway: SyncSheetGateway;
  readonly workerId: string;
  readonly now: number;
  readonly maxEffects: number;
  readonly writerRole?: string;
  readonly writerLeaseDurationMs?: number;
  readonly effectLeaseDurationMs?: number;
  readonly makeRepairReplan?: RepairReplanFactory;
}

/** Counters that make partial results and recovery visible to callers. */
export interface SyncEffectWorkerReport {
  readonly lease: WriterLease | null;
  readonly selected: number;
  readonly claimed: number;
  readonly applied: number;
  readonly blockedCandidate: number;
  readonly superseded: number;
  readonly conflicted: number;
  readonly failed: number;
  readonly deferred: number;
  readonly replanned: number;
  readonly responseLossRecovered: number;
}

interface ClaimedEffect {
  readonly pending: PendingEffect;
  readonly claimToken: string;
  readonly gatewayEffect: SyncGatewayEffect | null;
  readonly invalidPayloadError: string | null;
}

/**
 * Processes head-of-line effects once under a renewable worker fence.
 *
 * A missing batch result is deliberately treated exactly like response loss:
 * the worker reads a remote postcondition before it records any terminal
 * local status.  It never changes `applied` back to `pending`.
 */
export async function runSyncEffectWorker(
  options: SyncEffectWorkerOptions,
): Promise<SyncEffectWorkerReport> {
  validateOptions(options);
  const role = options.writerRole ?? "sync-effect-worker";
  const leaseDuration = options.writerLeaseDurationMs ?? 60_000;
  const effectLeaseDuration = options.effectLeaseDurationMs ?? 30_000;
  const lease = claimWriterLease(options.database, {
    role,
    writerId: options.workerId,
    leaseDurationMs: leaseDuration,
    now: options.now,
  });
  const report = mutableReport(lease);
  if (lease === null) return freezeReport(report);
  const fence = fenceFromLease(lease, options.now);
  const selected = listReadyEffects(options.database, options.maxEffects);
  report.selected = selected.length;

  const claimed: ClaimedEffect[] = [];
  for (const pending of selected) {
    const claimToken = "claim:" + randomUUID();
    const claim = claimEffect(options.database, {
      ...fence,
      effectId: pending.effect_id,
      claimToken,
      leaseDurationMs: effectLeaseDuration,
    });
    if (!claim.success) continue;
    report.claimed += 1;
    try {
      claimed.push({
        pending,
        claimToken,
        gatewayEffect: toGatewayEffect(pending),
        invalidPayloadError: null,
      });
    } catch (error: unknown) {
      claimed.push({
        pending,
        claimToken,
        gatewayEffect: null,
        invalidPayloadError: safeErrorMessage(error),
      });
    }
  }

  const usable = claimed.filter((item) => item.gatewayEffect !== null);
  for (const invalid of claimed.filter((item) => item.gatewayEffect === null)) {
    completeFailure(options.database, fence, invalid, "invalid_effect_payload", invalid.invalidPayloadError, report);
  }

  // A User_Input reconcile is a canonical projection only while no unresolved
  // user candidate owns one of its fields.  This local gate runs before the
  // remote CAS so a stale canonical effect cannot erase a candidate merely
  // because its sheet baseline happens to still look unchanged.
  const dispatchable = usable.filter((item) => {
    if (!isCandidateReconcileBlocked(options.database, item)) return true;
    if (applyEffectResult(options.database, {
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status: "blocked_candidate",
      lastErrorCode: "active_candidate_preserved",
      lastErrorMessage: "An unresolved User_Input candidate owns a projected field.",
    })) {
      report.blockedCandidate += 1;
    }
    return false;
  });

  for (const group of groupByGatewayRequest(dispatchable)) {
    let results: readonly SyncGatewayEffectResult[] | null = null;
    const deferredEffectIds = new Set<string>();
    try {
      const response = await options.gateway.applyEffects(group.request);
      results = response.results;
      const byEffectId = new Map(results.map((result) => [result.effectId, result]));
      for (const item of group.items) {
        const result = byEffectId.get(item.pending.effect_id) ?? null;
        if (result === null && response.hasMore) {
          if (releaseUnprocessedEffect(options.database, {
            ...fence,
            effectId: item.pending.effect_id,
            claimToken: item.claimToken,
          })) {
            report.deferred += 1;
            deferredEffectIds.add(item.pending.effect_id);
          }
        }
      }
    } catch {
      // Remote side may have written the effect before transport failed.
      for (const item of group.items) {
        await recoverUnknownResult(options, fence, item, report);
      }
      continue;
    }

    if (results === null) continue;

    const byEffectId = new Map(results.map((result) => [result.effectId, result]));
    for (const item of group.items) {
      const result = byEffectId.get(item.pending.effect_id) ?? null;
      if (result === null && deferredEffectIds.has(item.pending.effect_id)) continue;
      if (result === null || result.payloadHash !== item.pending.payload_hash) {
        await recoverUnknownResult(options, fence, item, report);
        continue;
      }
      if (
        (result.status === "applied" || result.status === "already_applied") &&
        (
          result.postcondition !== "verified" ||
          result.visibleRevision === null ||
          result.visibleHash === null ||
          result.visibleHash !== item.gatewayEffect?.payload.targetVisibleHash
        )
      ) {
        // A success label without a verified row state is not enough to close
        // a durable effect. Treat it like a lost response and read back first.
        await recoverUnknownResult(options, fence, item, report);
        continue;
      }
      completeGatewayResult(options, fence, item, result, report);
    }
  }

  return freezeReport(report);
}

/**
 * Returns true when SQLite still has an unresolved candidate for a field a
 * User_Input reconcile would overwrite.
 *
 * The single writer lease serializes candidate creation with this check; the
 * gateway's visible CAS remains the second protection against a Sheet edit
 * that happens while the request is in flight.
 */
function isCandidateReconcileBlocked(db: DatabaseSyncLike, item: ClaimedEffect): boolean {
  const effect = item.gatewayEffect;
  if (effect === null || effect.effectKind !== "candidate_reconcile" || item.pending.row_binding_id === null) {
    return false;
  }
  const fieldNames = Object.keys(effect.payload.fields);
  if (fieldNames.length === 0) return true;
  const placeholders = fieldNames.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT 1 AS blocked
    FROM sheet_visible_field_state AS visible
    LEFT JOIN sync_conflict AS conflict
      ON conflict.conflict_id = visible.active_candidate_conflict_id
    WHERE visible.physical_sheet_id = ?
      AND visible.projection = 'user_input'
      AND visible.row_binding_id = ?
      AND visible.field_name IN (${placeholders})
      AND visible.active_candidate_conflict_id IS NOT NULL
      AND visible.active_candidate_hash IS NOT NULL
      AND (conflict.conflict_id IS NULL OR conflict.status IN ('OPEN', 'NEEDS_REBASE'))
    LIMIT 1
  `).get(
    item.pending.physical_sheet_id,
    item.pending.row_binding_id,
    ...fieldNames,
  ) as { readonly blocked: number } | undefined;
  return row !== undefined;
}

function completeGatewayResult(
  options: SyncEffectWorkerOptions,
  fence: FencingContext,
  item: ClaimedEffect,
  result: SyncGatewayEffectResult,
  report: MutableReport,
): void {
  if (result.status === "applied" || result.status === "already_applied") {
    completeApplied(options.database, fence, item, result.visibleRevision, result.visibleHash, report);
    return;
  }
  if (result.status === "superseded") {
    if (applyEffectResult(options.database, {
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status: "superseded",
      lastErrorCode: "gateway_superseded",
      lastErrorMessage: result.reason,
    })) report.superseded += 1;
    return;
  }
  if (result.status === "guard_mismatch") {
    const status = item.pending.effect_kind === "candidate_reconcile" ? "blocked_candidate" : "conflict";
    const applied = applyEffectResult(options.database, {
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status,
      lastErrorCode: status === "blocked_candidate" ? "candidate_guard_mismatch" : "visible_guard_mismatch",
      lastErrorMessage: result.reason,
    });
    if (applied) {
      if (status === "blocked_candidate") report.blockedCandidate += 1;
      else report.conflicted += 1;
    }
    return;
  }
  if (result.status === "repair_reobserve") {
    replanOrFail(options, fence, item, { effect: item.pending, gatewayResult: result, postcondition: null }, report);
    return;
  }
  completeFailure(
    options.database,
    fence,
    item,
    result.status === "schema_error" ? "gateway_schema_error" : "gateway_retryable_error",
    result.reason,
    report,
  );
}

async function recoverUnknownResult(
  options: SyncEffectWorkerOptions,
  fence: FencingContext,
  item: ClaimedEffect,
  report: MutableReport,
): Promise<void> {
  if (item.gatewayEffect === null) {
    completeFailure(options.database, fence, item, "invalid_effect_payload", item.invalidPayloadError, report);
    return;
  }
  let postcondition: SyncEffectPostcondition;
  try {
    postcondition = await options.gateway.readEffectPostcondition(item.gatewayEffect);
  } catch (error: unknown) {
    completeFailure(
      options.database,
      fence,
      item,
      "postcondition_read_failed",
      safeErrorMessage(error),
      report,
    );
    return;
  }

  if (postcondition.disposition === "applied" &&
    postcondition.visibleRevision !== null && postcondition.visibleHash !== null) {
    completeApplied(options.database, fence, item, postcondition.visibleRevision, postcondition.visibleHash, report);
    report.responseLossRecovered += 1;
    return;
  }
  if (postcondition.disposition === "applied") {
    completeFailure(
      options.database,
      fence,
      item,
      "postcondition_applied_without_visible_state",
      "Gateway claimed an applied postcondition without a verified visible revision and hash.",
      report,
    );
    return;
  }
  if (postcondition.disposition === "changed" && item.pending.effect_kind === "system_repair") {
    replanOrFail(options, fence, item, { effect: item.pending, gatewayResult: null, postcondition }, report);
    return;
  }
  const code = postcondition.disposition === "unavailable"
    ? "postcondition_unavailable"
    : postcondition.disposition === "changed"
      ? "postcondition_changed"
      : "postcondition_unapplied_requires_redrive";
  completeFailure(options.database, fence, item, code, "Gateway response was not observed; postcondition=" + postcondition.disposition, report);
}

function completeApplied(
  db: DatabaseSyncLike,
  fence: FencingContext,
  item: ClaimedEffect,
  visibleRevision: number | null,
  visibleHash: string | null,
  report: MutableReport,
): void {
  const gatewayEffect = item.gatewayEffect;
  const confirmation = gatewayEffect !== null && item.pending.row_binding_id !== null &&
    visibleRevision !== null && visibleHash !== null
    ? {
      physicalSheetId: item.pending.physical_sheet_id,
      projection: item.pending.projection,
      rowBindingId: item.pending.row_binding_id,
      visibleRevision,
      visibleHash,
      entityRevision: item.pending.target_entity_revision,
      fieldHashes: Object.fromEntries(
        Object.entries(gatewayEffect.payload.fields).map(([fieldName, value]) => [fieldName, stableHash(value)]),
      ),
    }
    : undefined;
  const applied = applyEffectResult(db, {
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    status: "applied",
    ...(confirmation === undefined ? {} : { projectionConfirmation: confirmation }),
  });
  if (applied) report.applied += 1;
}

function replanOrFail(
  options: SyncEffectWorkerOptions,
  fence: FencingContext,
  item: ClaimedEffect,
  request: RepairReplanRequest,
  report: MutableReport,
): void {
  if (options.makeRepairReplan === undefined) {
    completeFailure(
      options.database,
      fence,
      item,
      "repair_reobserve_requires_writer_replan",
      "A system repair changed remotely and no writer replan factory was configured.",
      report,
    );
    return;
  }
  let replacement: NewEffect | null;
  try {
    replacement = options.makeRepairReplan(request);
  } catch (error: unknown) {
    completeFailure(options.database, fence, item, "repair_replan_failed", safeErrorMessage(error), report);
    return;
  }
  if (replacement === null) {
    completeFailure(
      options.database,
      fence,
      item,
      "repair_replan_deferred",
      "Writer deferred repair replan pending a fresh observation.",
      report,
    );
    return;
  }
  try {
    supersedeAndReplan(options.database, fence, item.pending.effect_id, replacement);
    report.replanned += 1;
  } catch (error: unknown) {
    completeFailure(options.database, fence, item, "repair_replan_failed", safeErrorMessage(error), report);
  }
}

function completeFailure(
  db: DatabaseSyncLike,
  fence: FencingContext,
  item: ClaimedEffect,
  code: string,
  message: string | null,
  report: MutableReport,
): void {
  if (applyEffectResult(db, {
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    status: "failed",
    lastErrorCode: code,
    lastErrorMessage: message,
  })) report.failed += 1;
}

function toGatewayEffect(effect: PendingEffect): SyncGatewayEffect {
  if (!isSyncEffectKind(effect.effect_kind)) {
    throw new Error("unsupported sync effect kind: " + effect.effect_kind);
  }
  if (!isSyncProjection(effect.projection)) {
    throw new Error("unsupported sync projection: " + effect.projection);
  }
  return {
    effectId: effect.effect_id,
    payloadHash: effect.payload_hash,
    effectKind: effect.effect_kind,
    physicalSheetId: effect.physical_sheet_id,
    projection: effect.projection,
    targetKind: effect.target_kind,
    targetId: effect.target_id,
    rowBindingId: effect.row_binding_id,
    conflictId: effect.conflict_id,
    expectedVisibleRevision: effect.expected_visible_revision,
    expectedVisibleHash: effect.expected_visible_hash,
    repairGuardHash: effect.repair_guard_hash,
    payload: parseSyncProjectionEffectPayload(effect.payload_json),
  };
}

function groupByGatewayRequest(items: readonly ClaimedEffect[]): readonly {
  readonly request: ApplySyncEffectsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, { request: ApplySyncEffectsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (effect === null) continue;
    const key = [
      effect.physicalSheetId,
      effect.payload.sheetName,
      effect.payload.registeredRange,
      effect.projection,
      effect.payload.schemaVersion,
    ].join("\u0000");
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.physicalSheetId,
          sheetName: effect.payload.sheetName,
          registeredRange: effect.payload.registeredRange,
          projection: effect.projection,
          schemaVersion: effect.payload.schemaVersion,
          effects: [effect],
        },
        items: [item],
      });
    } else {
      existing.request = { ...existing.request, effects: [...existing.request.effects, effect] };
      existing.items.push(item);
    }
  }
  return [...groups.values()];
}

function isSyncEffectKind(value: string): value is SyncGatewayEffect["effectKind"] {
  return value === "system_projection" || value === "candidate_reconcile" ||
    value === "system_repair" || value === "resolution_projection" || value === "resolution_delete";
}

function isSyncProjection(value: string): value is SyncProjection {
  return value === "user_input" || value === "system_state" || value === "sync_conflicts";
}

function fenceFromLease(lease: WriterLease, now: number): FencingContext {
  return {
    role: lease.role,
    writerEpoch: lease.writerEpoch,
    fencingToken: lease.fencingToken,
    now,
  };
}

interface MutableReport {
  lease: WriterLease | null;
  selected: number;
  claimed: number;
  applied: number;
  blockedCandidate: number;
  superseded: number;
  conflicted: number;
  failed: number;
  deferred: number;
  replanned: number;
  responseLossRecovered: number;
}

function mutableReport(lease: WriterLease | null): MutableReport {
  return {
    lease,
    selected: 0,
    claimed: 0,
    applied: 0,
    blockedCandidate: 0,
    superseded: 0,
    conflicted: 0,
    failed: 0,
    deferred: 0,
    replanned: 0,
    responseLossRecovered: 0,
  };
}

function freezeReport(report: MutableReport): SyncEffectWorkerReport {
  return { ...report };
}

function validateOptions(options: SyncEffectWorkerOptions): void {
  if (options.workerId.length === 0) throw new Error("effect worker ID is required");
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new Error("effect worker time must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.maxEffects) || options.maxEffects < 1) {
    throw new Error("effect worker maxEffects must be a positive safe integer");
  }
  for (const [name, value] of [
    ["writerLeaseDurationMs", options.writerLeaseDurationMs],
    ["effectLeaseDurationMs", options.effectLeaseDurationMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(name + " must be a positive safe integer");
    }
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync gateway failure";
}
