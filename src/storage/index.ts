export { CURRENT_SCHEMA_VERSION, migrateSchema, schemaDdl } from "./sqlite/schema.js";
export type { SchemaMigrationResult } from "./sqlite/schema.js";
export { commitCanonicalChanges } from "./state/canonicalCommit.js";
export type {
  CanonicalCommitInput,
  CanonicalCommitResult,
  CanonicalFieldWrite,
  CanonicalFieldCommitInput,
  CanonicalInsertCommitInput,
  CanonicalUpdateCommitInput,
  CanonicalDeleteCommitInput,
} from "./state/canonicalCommit.js";
export {
  openDatabase,
  openReadOnlyDatabase,
  getDatabaseSync,
  withImmediateTransaction,
} from "./sqlite/sqliteBridge.js";
export type { DatabaseSyncLike, StatementLike } from "./sqlite/sqliteBridge.js";
export {
  claimWriterLease,
  readWriterLease,
  isFencingValid,
} from "./sync/writerLease.js";
export type { WriterLease, ClaimLeaseOptions, FencingContext } from "./sync/writerLease.js";
export {
  claimEffect,
  applyEffectResult,
  supersedeAndReplan,
  recoverExpiredLeases,
  releaseUnprocessedEffect,
  findPendingEffectsByTarget,
  listReadyEffects,
  appendPendingEffects,
} from "./sync/effectOutbox.js";
export type {
  ClaimResult,
  ClaimEffectOptions,
  ApplyResultOptions,
  EffectProjectionConfirmation,
  NewEffect,
  PendingEffect,
} from "./sync/effectOutbox.js";
export { persistObservedRow } from "./state/observationWriter.js";
export type {
  ObservationAttemptInput,
  EventIdentityInput,
  BusinessKeyChange,
  CanonicalRowMutation,
  PersistObservedRowInput,
  PersistObservedRowResult,
} from "./state/observationWriter.js";
export { persistResolutionCommand } from "./state/resolutionWriter.js";
export type {
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
} from "./state/resolutionWriter.js";
export { registerSyncSheet, requireRegisteredSyncSheet } from "./sync/syncRegistry.js";
export type {
  RegisteredProjection,
  RegisterSyncSheetInput,
  RegisteredSyncSheet,
  RegisterSyncSheetResult,
} from "./sync/syncRegistry.js";
export { persistReadOnlySnapshotObservation } from "./state/readOnlyObservation.js";
export type {
  ReadOnlySnapshotObservationInput,
  ReadOnlySnapshotObservationResult,
} from "./state/readOnlyObservation.js";
export {
  inspectRestoredBackup,
  beginRestoreReconciliation,
  completeRestoreReconciliation,
  requireRestoreAllowsSheetWrites,
} from "./recovery/restoreRecovery.js";
export type {
  RestoreInspection,
  BeginRestoreReconciliationOptions,
  RestoreReconciliation,
  RestoreEffectDisposition,
  RestoreEffectReconciliation,
  CompleteRestoreReconciliationOptions,
  ReadyRestore,
} from "./recovery/restoreRecovery.js";
