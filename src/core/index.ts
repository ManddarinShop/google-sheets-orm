// Core domain layer — pure evaluator and model types.

// Encoding
export { stableEncode, stableHash } from "./encoding/index.js";
export type {
  NormalizedCell,
  DateValue,
  CellObservation,
  StableValue,
} from "./encoding/index.js";

// Model
export type {
  CanonicalFieldState,
  CanonicalEntityState,
  FieldOwnership,
  Projection,
  RowBindingState,
  NormalizedRow,
  NormalizedRowField,
  ObservationSource,
  RowOperation,
  DeleteEvidence,
  EditorActorSource,
  ObservedFieldChange,
  ObservedRowChange,
  ObservedEditBatch,
  SheetChangeEvent,
  ConflictStatus,
  SyncConflict,
  QuarantineReason,
  QuarantinePlan,
  RepairPlan,
  FieldManifestEntry,
  OwnershipManifest,
  RowBindingContext,
  ResolutionAction,
  ActorRole,
  ResolutionCommand,
  EffectKind,
  EffectTargetKind,
  EffectStatus,
  SheetEffect,
} from "./model/index.js";

// Evaluator
export {
  evaluateBatch,
  computeEventKey,
  computeRowHash,
  computeRepairGuardHash,
} from "./evaluate/index.js";
export type {
  BatchEvaluationResult,
  RowEvaluationResult,
  RowOutcome,
  BatchOutcome,
  AcceptedField,
  FieldConflict,
  EvaluationContext,
  EventKeyField,
} from "./evaluate/index.js";

// Conflict transitions
export {
  shouldRebaseConflict,
  applyResolution,
} from "./conflict/index.js";
export type { ConflictTransitionResult } from "./conflict/index.js";
