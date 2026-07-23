/**
 * Fenced outbox worker for projection effects.
 *
 * It owns only claim/result transitions.  Canonical state and any repair
 * replan payload are supplied by the writer boundary; the gateway is never
 * allowed to choose a winner or silently retry a response-lost write.
 */

import { randomUUID } from "node:crypto";
import {
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type Applicability,
  type EffectKind,
  type EffectStatus,
  type EffectTargetKind,
  type LookupResult,
  type Presence,
} from "../../core/index.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../core/state/constants.js";
import { CONFLICT_STATUSES } from "../../core/model/constants.js";
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
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../storage/errors.js";
import { fromSqlNullable } from "../../storage/sqlite/sqlState.js";
import {
  parseSyncProjectionEffectPayload,
  type ApplySyncEffectsRequest,
  type SyncEffectPostcondition,
  type SyncGatewayEffect,
  type SyncGatewayEffectResult,
  type SyncProjection,
  type SyncSheetGateway,
} from "../gateway/syncGateway.js";
import {
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
  SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
} from "../gateway/constants.js";

const DEFAULT_WORKER_ROLE = "sync-effect-worker";
const DEFAULT_WRITER_LEASE_DURATION_MS = 60_000;
const DEFAULT_EFFECT_LEASE_DURATION_MS = 30_000;

const WRITER_LEASE_CLAIM_KINDS = {
  CLAIMED: "claimed",
  NOT_CLAIMED: "not_claimed",
} as const;

const SYNC_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: "resolution_delete",
} as const satisfies Record<string, EffectKind>;

const EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  ROW_BINDING: "row_binding",
  PROJECTION_ROW: "projection_row",
  CONFLICT: "conflict",
} as const satisfies Record<string, EffectTargetKind>;

const OUTBOX_EFFECT_STATUSES = {
  APPLIED: "applied",
  BLOCKED_CANDIDATE: "blocked_candidate",
  SUPERSEDED: "superseded",
  CONFLICT: "conflict",
  FAILED: "failed",
} as const satisfies Record<string, EffectStatus>;

const WORKER_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_effect_payload",
  ACTIVE_CANDIDATE_PRESERVED: "active_candidate_preserved",
  GATEWAY_SUPERSEDED: "gateway_superseded",
  CANDIDATE_GUARD_MISMATCH: "candidate_guard_mismatch",
  VISIBLE_GUARD_MISMATCH: "visible_guard_mismatch",
  GATEWAY_SCHEMA_ERROR: "gateway_schema_error",
  GATEWAY_RETRYABLE_ERROR: "gateway_retryable_error",
  POSTCONDITION_READ_FAILED: "postcondition_read_failed",
  POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE: "postcondition_applied_without_visible_state",
  POSTCONDITION_UNAVAILABLE: "postcondition_unavailable",
  POSTCONDITION_CHANGED: "postcondition_changed",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE: "postcondition_unapplied_requires_redrive",
  REPAIR_REOBSERVE_REQUIRES_WRITER_REPLAN: "repair_reobserve_requires_writer_replan",
  REPAIR_REPLAN_FAILED: "repair_replan_failed",
  REPAIR_REPLAN_DEFERRED: "repair_replan_deferred",
} as const;

type SyncEffectWorkerErrorCode =
  (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];

const CANDIDATE_RECONCILE_BLOCK_SQL = `
    SELECT 1 AS blocked
    FROM sheet_visible_field_state AS visible
    LEFT JOIN sync_conflict AS conflict
      ON conflict.conflict_id = visible.active_candidate_conflict_id
    WHERE visible.physical_sheet_id = ?
      AND visible.projection = '${SYNC_GATEWAY_PROJECTIONS.USER_INPUT}'
      AND visible.row_binding_id = ?
      AND visible.field_name IN (__FIELD_NAMES__)
      AND visible.active_candidate_conflict_id IS NOT NULL
      AND visible.active_candidate_hash IS NOT NULL
      AND (conflict.conflict_id IS NULL OR conflict.status IN (
        '${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}'
      ))
    LIMIT 1
  `;

/** An effect plus evidence supplied to a writer-owned system-repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly gatewayResult: Presence<SyncGatewayEffectResult>;
  readonly postcondition: Presence<SyncEffectPostcondition>;
}

/** Callback that creates a fresh effect without mutating the old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => Presence<NewEffect>;

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
  readonly lease: Presence<WriterLease>;
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
  readonly gatewayEffect: Presence<SyncGatewayEffect>;
  readonly invalidPayloadError: Presence<string>;
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
  const role = options.writerRole ?? DEFAULT_WORKER_ROLE;
  const leaseDuration = options.writerLeaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
  const effectLeaseDuration = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
  const claimResult = claimWriterLease(options.database, {
    role,
    writerId: options.workerId,
    leaseDurationMs: leaseDuration,
    now: options.now,
  });
  const lease = claimResult.kind === WRITER_LEASE_CLAIM_KINDS.CLAIMED
    ? presentValue(claimResult.lease)
    : absentValue<WriterLease>();
  const report = mutableReport(lease);
  if (claimResult.kind === WRITER_LEASE_CLAIM_KINDS.NOT_CLAIMED) {
    return freezeReport(report);
  }
  const fence = fenceFromLease(claimResult.lease, options.now);
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
        gatewayEffect: presentValue(toGatewayEffect(pending)),
        invalidPayloadError: absentValue(),
      });
    } catch (error: unknown) {
      claimed.push({
        pending,
        claimToken,
        gatewayEffect: absentValue(),
        invalidPayloadError: presentValue(safeErrorMessage(error)),
      });
    }
  }

  const usable = claimed.filter((item) => isPresent(item.gatewayEffect));
  for (const invalid of claimed.filter((item) => isAbsent(item.gatewayEffect))) {
    completeFailure(
      options.database,
      fence,
      invalid,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      invalid.invalidPayloadError,
      report,
    );
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
      status: OUTBOX_EFFECT_STATUSES.BLOCKED_CANDIDATE,
      lastErrorCode: presentValue(WORKER_ERROR_CODES.ACTIVE_CANDIDATE_PRESERVED),
      lastErrorMessage: presentValue("An unresolved User_Input candidate owns a projected field."),
    })) {
      report.blockedCandidate += 1;
    }
    return false;
  });

  for (const group of groupByGatewayRequest(dispatchable)) {
    const deferredEffectIds = new Set<string>();
    let response: Awaited<ReturnType<SyncSheetGateway["applyEffects"]>>;
    try {
      response = await options.gateway.applyEffects(group.request);
    } catch {
      // Remote side may have written the effect before transport failed.
      for (const item of group.items) {
        await recoverUnknownResult(options, fence, item, report);
      }
      continue;
    }

    const byEffectId = new Map(response.results.map((result) => [result.effectId, result]));
    for (const item of group.items) {
      const result = lookupResult(byEffectId.get(item.pending.effect_id));
      if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND && response.hasMore) {
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
    for (const item of group.items) {
      const result = lookupResult(byEffectId.get(item.pending.effect_id));
      if (
        result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND &&
        deferredEffectIds.has(item.pending.effect_id)
      ) continue;
      if (
        result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
        result.value.payloadHash !== item.pending.payload_hash
      ) {
        await recoverUnknownResult(options, fence, item, report);
        continue;
      }
      if (
        (result.value.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
          result.value.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED) &&
        (
          result.value.postcondition !== SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED ||
          !isPresent(result.value.visibleRevision) ||
          !isPresent(result.value.visibleHash) ||
          !isPresent(item.gatewayEffect) ||
          result.value.visibleHash.value !== item.gatewayEffect.value.payload.targetVisibleHash
        )
      ) {
        // A success label without a verified row state is not enough to close
        // a durable effect. Treat it like a lost response and read back first.
        await recoverUnknownResult(options, fence, item, report);
        continue;
      }
      completeGatewayResult(options, fence, item, result.value, report);
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
  if (
    !isPresent(effect) ||
    effect.value.effectKind !== SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    !isPresent(effect.value.rowBindingId)
  ) {
    return false;
  }
  const fieldNames = Object.keys(effect.value.payload.fields);
  if (fieldNames.length === 0) return true;
  const placeholders = fieldNames.map(() => "?").join(", ");
  const blockSql = CANDIDATE_RECONCILE_BLOCK_SQL.replace("__FIELD_NAMES__", placeholders);
  const row = lookupResult(
    db.prepare(blockSql).get<CandidateBlockSqlRow>(
      effect.value.physicalSheetId,
      effect.value.rowBindingId.value,
      ...fieldNames,
    ),
  );
  return row.kind === LOOKUP_RESULT_KINDS.FOUND;
}

function completeGatewayResult(
  options: SyncEffectWorkerOptions,
  fence: FencingContext,
  item: ClaimedEffect,
  result: SyncGatewayEffectResult,
  report: MutableReport,
): void {
  if (
    result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
    result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED
  ) {
    completeApplied(options.database, fence, item, result.visibleRevision, result.visibleHash, report);
    return;
  }
  if (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SUPERSEDED) {
    if (applyEffectResult(options.database, {
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status: OUTBOX_EFFECT_STATUSES.SUPERSEDED,
      lastErrorCode: presentValue(WORKER_ERROR_CODES.GATEWAY_SUPERSEDED),
      lastErrorMessage: result.reason,
    })) report.superseded += 1;
    return;
  }
  if (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH) {
    const blocked = isPresent(item.gatewayEffect) &&
      item.gatewayEffect.value.effectKind === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE;
    const status = blocked
      ? OUTBOX_EFFECT_STATUSES.BLOCKED_CANDIDATE
      : OUTBOX_EFFECT_STATUSES.CONFLICT;
    const applied = applyEffectResult(options.database, {
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status,
      lastErrorCode: presentValue(
        blocked
          ? WORKER_ERROR_CODES.CANDIDATE_GUARD_MISMATCH
          : WORKER_ERROR_CODES.VISIBLE_GUARD_MISMATCH,
      ),
      lastErrorMessage: result.reason,
    });
    if (applied) {
      if (blocked) report.blockedCandidate += 1;
      else report.conflicted += 1;
    }
    return;
  }
  if (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE) {
    replanOrFail(
      options,
      fence,
      item,
      {
        effect: item.pending,
        gatewayResult: presentValue(result),
        postcondition: absentValue(),
      },
      report,
    );
    return;
  }
  completeFailure(
    options.database,
    fence,
    item,
    result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR
      ? WORKER_ERROR_CODES.GATEWAY_SCHEMA_ERROR
      : WORKER_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
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
  if (!isPresent(item.gatewayEffect)) {
    completeFailure(
      options.database,
      fence,
      item,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      item.invalidPayloadError,
      report,
    );
    return;
  }
  let postcondition: SyncEffectPostcondition;
  try {
    postcondition = await options.gateway.readEffectPostcondition(item.gatewayEffect.value);
  } catch (error: unknown) {
    completeFailure(
      options.database,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
      presentValue(safeErrorMessage(error)),
      report,
    );
    return;
  }

  if (
    postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED &&
    isPresent(postcondition.visibleRevision) &&
    isPresent(postcondition.visibleHash)
  ) {
    completeApplied(options.database, fence, item, postcondition.visibleRevision, postcondition.visibleHash, report);
    report.responseLossRecovered += 1;
    return;
  }
  if (postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED) {
    completeFailure(
      options.database,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE,
      presentValue("Gateway claimed an applied postcondition without a verified visible revision and hash."),
      report,
    );
    return;
  }
  if (
    postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED &&
    item.gatewayEffect.value.effectKind === SYNC_EFFECT_KINDS.SYSTEM_REPAIR
  ) {
    replanOrFail(
      options,
      fence,
      item,
      {
        effect: item.pending,
        gatewayResult: absentValue(),
        postcondition: presentValue(postcondition),
      },
      report,
    );
    return;
  }
  const code = postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE
    ? WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE
    : postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED
      ? WORKER_ERROR_CODES.POSTCONDITION_CHANGED
      : WORKER_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE;
  completeFailure(
    options.database,
    fence,
    item,
    code,
    presentValue("Gateway response was not observed; postcondition=" + postcondition.disposition),
    report,
  );
}

function completeApplied(
  db: DatabaseSyncLike,
  fence: FencingContext,
  item: ClaimedEffect,
  visibleRevision: Presence<number>,
  visibleHash: Presence<string>,
  report: MutableReport,
): void {
  const gatewayEffect = item.gatewayEffect;
  const confirmation = isPresent(gatewayEffect) &&
    isPresent(gatewayEffect.value.rowBindingId) &&
    isPresent(visibleRevision) &&
    isPresent(visibleHash)
    ? {
      physicalSheetId: item.pending.physical_sheet_id,
      projection: item.pending.projection,
      rowBindingId: gatewayEffect.value.rowBindingId.value,
      visibleRevision: visibleRevision.value,
      visibleHash: visibleHash.value,
      entityRevision: applicabilityFromSqlNullable(item.pending.target_entity_revision),
      fieldHashes: Object.fromEntries(
        Object.entries(gatewayEffect.value.payload.fields)
          .map(([fieldName, value]) => [fieldName, stableHash(value)]),
      ),
    }
    : undefined;
  const applied = applyEffectResult(db, {
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    status: OUTBOX_EFFECT_STATUSES.APPLIED,
    lastErrorCode: absentValue(),
    lastErrorMessage: absentValue(),
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
      WORKER_ERROR_CODES.REPAIR_REOBSERVE_REQUIRES_WRITER_REPLAN,
      presentValue("A system repair changed remotely and no writer replan factory was configured."),
      report,
    );
    return;
  }
  let replacement: Presence<NewEffect>;
  try {
    replacement = options.makeRepairReplan(request);
  } catch (error: unknown) {
    completeFailure(
      options.database,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REPLAN_FAILED,
      presentValue(safeErrorMessage(error)),
      report,
    );
    return;
  }
  if (!isPresent(replacement)) {
    completeFailure(
      options.database,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REPLAN_DEFERRED,
      presentValue("Writer deferred repair replan pending a fresh observation."),
      report,
    );
    return;
  }
  try {
    supersedeAndReplan(options.database, fence, item.pending.effect_id, replacement.value);
    report.replanned += 1;
  } catch (error: unknown) {
    completeFailure(
      options.database,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REPLAN_FAILED,
      presentValue(safeErrorMessage(error)),
      report,
    );
  }
}

function completeFailure(
  db: DatabaseSyncLike,
  fence: FencingContext,
  item: ClaimedEffect,
  code: SyncEffectWorkerErrorCode,
  message: Presence<string>,
  report: MutableReport,
): void {
  if (applyEffectResult(db, {
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    status: OUTBOX_EFFECT_STATUSES.FAILED,
    lastErrorCode: presentValue(code),
    lastErrorMessage: message,
  })) report.failed += 1;
}

function toGatewayEffect(effect: PendingEffect): SyncGatewayEffect {
  if (!isSyncEffectKind(effect.effect_kind)) {
    throwWorkerError("unsupported sync effect kind: " + effect.effect_kind);
  }
  if (!isSyncProjection(effect.projection)) {
    throwWorkerError("unsupported sync projection: " + effect.projection);
  }
  if (!isEffectTargetKind(effect.target_kind)) {
    throwWorkerError("unsupported sync effect target kind: " + effect.target_kind);
  }
  return {
    effectId: effect.effect_id,
    payloadHash: effect.payload_hash,
    effectKind: effect.effect_kind,
    physicalSheetId: effect.physical_sheet_id,
    projection: effect.projection,
    targetKind: effect.target_kind,
    targetId: effect.target_id,
    rowBindingId: fromSqlNullable(effect.row_binding_id),
    conflictId: fromSqlNullable(effect.conflict_id),
    expectedVisibleRevision: effect.expected_visible_revision,
    expectedVisibleHash: effect.expected_visible_hash,
    repairGuardHash: fromSqlNullable(effect.repair_guard_hash),
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
    if (!isPresent(effect)) continue;
    const key = [
      effect.value.physicalSheetId,
      effect.value.payload.sheetName,
      effect.value.payload.registeredRange,
      effect.value.projection,
      effect.value.payload.schemaVersion,
    ].join("\u0000");
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          effects: [effect.value],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        effects: [...existing.value.request.effects, effect.value],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

function isSyncEffectKind(value: string): value is SyncGatewayEffect["effectKind"] {
  return value === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION ||
    value === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    value === SYNC_EFFECT_KINDS.SYSTEM_REPAIR ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_PROJECTION ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_DELETE;
}

function isSyncProjection(value: string): value is SyncProjection {
  return value === SYNC_GATEWAY_PROJECTIONS.USER_INPUT ||
    value === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE ||
    value === SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS;
}

function isEffectTargetKind(value: string): value is EffectTargetKind {
  return value === EFFECT_TARGET_KINDS.ENTITY ||
    value === EFFECT_TARGET_KINDS.ROW_BINDING ||
    value === EFFECT_TARGET_KINDS.PROJECTION_ROW ||
    value === EFFECT_TARGET_KINDS.CONFLICT;
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
  lease: Presence<WriterLease>;
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

function mutableReport(lease: Presence<WriterLease>): MutableReport {
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
  if (options.workerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throwWorkerError("effect worker ID is required");
  }
  if (
    !Number.isSafeInteger(options.now) ||
    options.now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwWorkerError("effect worker time must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(options.maxEffects) ||
    options.maxEffects < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwWorkerError("effect worker maxEffects must be a positive safe integer");
  }
  for (const [name, value] of [
    ["writerLeaseDurationMs", options.writerLeaseDurationMs],
    ["effectLeaseDurationMs", options.effectLeaseDurationMs],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM)
    ) {
      throwWorkerError(name + " must be a positive safe integer");
    }
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync gateway failure";
}

interface CandidateBlockSqlRow {
  readonly blocked: number;
}

type PresentValue<T> = {
  readonly kind: typeof PRESENCE_KINDS.PRESENT;
  readonly value: T;
};

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function isPresent<T>(value: Presence<T>): value is PresentValue<T> {
  return value.kind === PRESENCE_KINDS.PRESENT;
}

function isAbsent<T>(value: Presence<T>): boolean {
  return value.kind === PRESENCE_KINDS.ABSENT;
}

function lookupResult<T>(value: T | undefined): LookupResult<T> {
  return value === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value };
}

function applicabilityFromSqlNullable<T>(value: T | null): Applicability<T> {
  return value === null
    ? { kind: APPLICABILITY_KINDS.NOT_APPLICABLE }
    : { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

function throwWorkerError(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PENDING_EFFECT, message);
}
