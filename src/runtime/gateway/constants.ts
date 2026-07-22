/** Protocol versions understood by the sync gateway contract. */
export const SYNC_GATEWAY_PROTOCOL_VERSIONS = {
  V1: "v1",
} as const;

export type SyncGatewayProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)[keyof typeof SYNC_GATEWAY_PROTOCOL_VERSIONS];

/** Projection labels accepted by the runtime gateway contract. */
export const SYNC_GATEWAY_PROJECTIONS = {
  USER_INPUT: "user_input",
  SYSTEM_STATE: "system_state",
  SYNC_CONFLICTS: "sync_conflicts",
} as const;

export type SyncGatewayProjection =
  (typeof SYNC_GATEWAY_PROJECTIONS)[keyof typeof SYNC_GATEWAY_PROJECTIONS];

/** Effect kinds that require special handling at the Apps Script boundary. */
export const SYNC_GATEWAY_EFFECT_KINDS = {
  RESOLUTION_DELETE: "resolution_delete",
} as const;

/** Terminal and retryable statuses returned for one gateway effect. */
export const SYNC_GATEWAY_EFFECT_RESULT_STATUSES = {
  APPLIED: "applied",
  ALREADY_APPLIED: "already_applied",
  SUPERSEDED: "superseded",
  GUARD_MISMATCH: "guard_mismatch",
  REPAIR_REOBSERVE: "repair_reobserve",
  SCHEMA_ERROR: "schema_error",
  RETRYABLE_ERROR: "retryable_error",
} as const;

export type SyncGatewayEffectResultStatus =
  (typeof SYNC_GATEWAY_EFFECT_RESULT_STATUSES)[keyof typeof SYNC_GATEWAY_EFFECT_RESULT_STATUSES];

/** Whether a gateway result includes a verified remote postcondition. */
export const SYNC_GATEWAY_POSTCONDITION_STATUSES = {
  VERIFIED: "verified",
  UNAVAILABLE: "unavailable",
} as const;

export type SyncGatewayPostconditionStatus =
  (typeof SYNC_GATEWAY_POSTCONDITION_STATUSES)[keyof typeof SYNC_GATEWAY_POSTCONDITION_STATUSES];

/** Read-back classification after a lost response or expired lease. */
export const SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS = {
  APPLIED: "applied",
  UNAPPLIED: "unapplied",
  CHANGED: "changed",
  UNAVAILABLE: "unavailable",
} as const;

export type SyncGatewayPostconditionDisposition =
  (typeof SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS)[keyof typeof SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS];
