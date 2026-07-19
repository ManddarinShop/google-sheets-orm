/**
 * Deterministic outbox payload builders for all v1 Sheet projections.
 *
 * The public repository never exposes insert/update/delete mechanics here.
 * These helpers translate a writer-approved canonical/candidate/resolution
 * decision into one immutable effect payload; the effect worker later performs
 * the remote compare-and-set through the gateway.
 */

import { stableHash, type NormalizedCell } from "../../core/index.js";
import type { NewEffect } from "../../storage/index.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
  type SyncEffectKind,
  type SyncProjection,
} from "../gateway/syncGateway.js";

/** Common immutable coordinates of a writer-approved projection effect. */
export interface ProjectionEffectInput {
  readonly effectId: string;
  readonly effectKind: SyncEffectKind;
  readonly commitId: string;
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly targetKind: "entity" | "row_binding" | "projection_row" | "conflict";
  readonly targetId: string;
  readonly rowBindingId: string | null;
  readonly conflictId: string | null;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly createIfMissing: boolean;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly expectedCandidateHash?: string | null;
  readonly repairGuardHash?: string | null;
  readonly sourceQuarantineId?: string | null;
  readonly targetEntityRevision?: number | null;
  readonly targetFieldRevisionHash?: string | null;
  readonly targetCanonicalCommitId?: string | null;
  readonly streamSequence: number;
}

/** Builds an immutable outbox row, including stable payload/dedupe identities. */
export function createProjectionEffect(input: ProjectionEffectInput): NewEffect {
  validateInput(input);
  const targetVisibleHash = computeSyncVisibleHash(input.fields);
  if (input.effectKind === "resolution_delete" && targetVisibleHash !== input.expectedVisibleHash) {
    throw new Error("resolution deletion requires the full current visible hash");
  }
  const payloadJson = serializeSyncProjectionEffectPayload({
    sheetName: input.sheetName,
    registeredRange: input.registeredRange,
    schemaVersion: input.schemaVersion,
    targetAnchor: input.targetAnchor,
    fields: input.fields,
    targetVisibleHash,
    createIfMissing: input.createIfMissing,
    expectedCandidateHash: input.expectedCandidateHash ?? null,
  });
  const payloadHash = stableHash({ payloadJson });
  return {
    effectId: input.effectId,
    effectKind: input.effectKind,
    commitId: input.commitId,
    logicalSheetId: input.logicalSheetId,
    physicalSheetId: input.physicalSheetId,
    projection: input.projection,
    rowBindingId: input.rowBindingId,
    conflictId: input.conflictId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetEntityRevision: input.targetEntityRevision ?? null,
    targetFieldRevisionHash: input.targetFieldRevisionHash ?? null,
    targetCanonicalCommitId: input.targetCanonicalCommitId ?? input.commitId,
    expectedVisibleRevision: input.expectedVisibleRevision,
    expectedVisibleHash: input.expectedVisibleHash,
    repairGuardHash: input.repairGuardHash ?? null,
    sourceQuarantineId: input.sourceQuarantineId ?? null,
    payloadJson,
    payloadHash,
    effectDedupeKey: stableHash({
      effectKind: input.effectKind,
      logicalSheetId: input.logicalSheetId,
      physicalSheetId: input.physicalSheetId,
      projection: input.projection,
      targetKind: input.targetKind,
      targetId: input.targetId,
      targetCanonicalCommitId: input.targetCanonicalCommitId ?? input.commitId,
      payloadHash,
    }),
    streamSequence: input.streamSequence,
  };
}

/** Creates a canonical System_State projection effect. */
export function createSystemProjectionEffect(
  input: Omit<ProjectionEffectInput, "effectKind">,
): NewEffect {
  if (input.projection !== "system_state") throw new Error("system projection must target system_state");
  return createProjectionEffect({ ...input, effectKind: "system_projection" });
}

/** Creates a baseline-CAS User_Input reconcile that cannot overwrite a candidate. */
export function createCandidateReconcileEffect(
  input: Omit<ProjectionEffectInput, "effectKind" | "projection"> & { readonly projection?: "user_input" },
): NewEffect {
  return createProjectionEffect({ ...input, projection: "user_input", effectKind: "candidate_reconcile" });
}

/** Creates a guard-specific repair effect; caller must preserve the quarantine link. */
export function createSystemRepairEffect(
  input: Omit<ProjectionEffectInput, "effectKind">,
): NewEffect {
  if (input.repairGuardHash === undefined || input.repairGuardHash === null || input.repairGuardHash.length === 0) {
    throw new Error("system repair requires a non-empty repairGuardHash");
  }
  if (input.sourceQuarantineId === undefined || input.sourceQuarantineId === null || input.sourceQuarantineId.length === 0) {
    throw new Error("system repair requires a sourceQuarantineId");
  }
  return createProjectionEffect({ ...input, effectKind: "system_repair" });
}

/** Creates the system-owned Sync_Conflicts control-row projection effect. */
export function createResolutionProjectionEffect(
  input: Omit<ProjectionEffectInput, "effectKind" | "projection" | "targetKind"> & {
    readonly projection?: "sync_conflicts";
  },
): NewEffect {
  if (input.conflictId === null || input.conflictId.length === 0 || input.targetId !== input.conflictId) {
    throw new Error("resolution projection must target exactly one conflict ID");
  }
  return createProjectionEffect({
    ...input,
    projection: "sync_conflicts",
    targetKind: "conflict",
    effectKind: "resolution_projection",
  });
}

/**
 * Creates a guarded deletion for one resolved system-owned conflict row.
 *
 * The payload carries the full currently visible conflict row as the expected
 * state. The gateway therefore deletes only the exact anchored row that the
 * resolver observed; it never deletes by mutable sheet row number.
 */
export function createResolutionDeleteEffect(
  input: Omit<ProjectionEffectInput, "effectKind" | "projection" | "targetKind"> & {
    readonly projection?: "sync_conflicts";
  },
): NewEffect {
  if (input.conflictId === null || input.conflictId.length === 0 || input.targetId !== input.conflictId) {
    throw new Error("resolution deletion must target exactly one conflict ID");
  }
  return createProjectionEffect({
    ...input,
    projection: "sync_conflicts",
    targetKind: "conflict",
    effectKind: "resolution_delete",
  });
}

function validateInput(input: ProjectionEffectInput): void {
  for (const [label, value] of [
    ["effect ID", input.effectId],
    ["commit ID", input.commitId],
    ["logical sheet ID", input.logicalSheetId],
    ["physical sheet ID", input.physicalSheetId],
    ["sheet name", input.sheetName],
    ["registered range", input.registeredRange],
    ["target ID", input.targetId],
    ["target anchor", input.targetAnchor],
  ] as const) {
    if (value.length === 0) throw new Error(label + " is required");
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1 ||
    !Number.isSafeInteger(input.expectedVisibleRevision) || input.expectedVisibleRevision < 0 ||
    !Number.isSafeInteger(input.streamSequence) || input.streamSequence < 1) {
    throw new Error("projection effect has an invalid schema, visible revision, or stream sequence");
  }
  if (input.createIfMissing) {
    if (input.expectedVisibleRevision !== 0 || input.expectedVisibleHash !== "") {
      throw new Error("new projection rows require an empty visible baseline");
    }
  } else if (input.expectedVisibleHash.length === 0) {
    throw new Error("existing projection effects require an expected visible hash");
  }
  if (Object.keys(input.fields).length === 0) throw new Error("projection effect must contain fields");
  if (input.effectKind === "candidate_reconcile" && input.projection !== "user_input") {
    throw new Error("candidate reconcile must target user_input");
  }
  if (
    (input.effectKind === "resolution_projection" || input.effectKind === "resolution_delete") &&
    input.projection !== "sync_conflicts"
  ) {
    throw new Error("resolution projection must target sync_conflicts");
  }
  if (input.effectKind === "resolution_delete" && (input.createIfMissing || input.expectedVisibleRevision < 1)) {
    throw new Error("resolution deletion requires an existing visible row");
  }
  if (input.rowBindingId === null && input.targetKind !== "conflict") {
    throw new Error("non-conflict projection effect requires a row binding ID");
  }
}
