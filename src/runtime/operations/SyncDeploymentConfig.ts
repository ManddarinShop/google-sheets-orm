/**
 * Startup validation for deployment-specific retention and privileged actors.
 *
 * These values are outside pure core policy: the deployer supplies durations
 * and service identities, while this module rejects unsafe relationships before
 * a writer or gateway process starts.
 */

/** Roles that can perform backend-only quarantine recovery actions. */
export type PrivilegedOperatorRole = "sync_operator" | "sync_admin";

/** Validated deployment values required by the SQLite sync runtime. */
export interface SyncDeploymentConfig {
  readonly rawObservationRetentionMs: number;
  readonly resolvedCandidateRetentionMs: number;
  readonly eventAuditRetentionMs: number;
  readonly dedupeReceiptRetentionMs: number;
  readonly gatewayReceiptRetentionMs: number;
  readonly backupRetentionMs: number;
  readonly sourceReplayWindowMs: number;
  readonly maxRetryWindowMs: number;
  readonly restoreReconciliationWindowMs: number;
  readonly operatorAuditWindowMs: number;
  readonly operatorRoleAllowlist: Readonly<Record<PrivilegedOperatorRole, readonly string[]>>;
}

/**
 * Parses and validates untrusted process configuration for a runtime startup.
 *
 * It rejects a deployment before it can shorten replay protection or leave
 * privileged recovery actions without explicit service-identity allowlists.
 */
export function requireValidSyncDeploymentConfig(input: unknown): SyncDeploymentConfig {
  const config = requireRecord(input, "deployment config");
  const sourceReplayWindowMs = requirePositiveDuration(config.sourceReplayWindowMs, "sourceReplayWindowMs");
  const maxRetryWindowMs = requirePositiveDuration(config.maxRetryWindowMs, "maxRetryWindowMs");
  const restoreReconciliationWindowMs = requirePositiveDuration(
    config.restoreReconciliationWindowMs,
    "restoreReconciliationWindowMs",
  );
  const operatorAuditWindowMs = requirePositiveDuration(
    config.operatorAuditWindowMs,
    "operatorAuditWindowMs",
  );

  const result: SyncDeploymentConfig = {
    rawObservationRetentionMs: requirePositiveDuration(
      config.rawObservationRetentionMs,
      "rawObservationRetentionMs",
    ),
    resolvedCandidateRetentionMs: requirePositiveDuration(
      config.resolvedCandidateRetentionMs,
      "resolvedCandidateRetentionMs",
    ),
    eventAuditRetentionMs: requirePositiveDuration(
      config.eventAuditRetentionMs,
      "eventAuditRetentionMs",
    ),
    dedupeReceiptRetentionMs: requirePositiveDuration(
      config.dedupeReceiptRetentionMs,
      "dedupeReceiptRetentionMs",
    ),
    gatewayReceiptRetentionMs: requirePositiveDuration(
      config.gatewayReceiptRetentionMs,
      "gatewayReceiptRetentionMs",
    ),
    backupRetentionMs: requirePositiveDuration(config.backupRetentionMs, "backupRetentionMs"),
    sourceReplayWindowMs,
    maxRetryWindowMs,
    restoreReconciliationWindowMs,
    operatorAuditWindowMs,
    operatorRoleAllowlist: requireOperatorRoleAllowlist(config.operatorRoleAllowlist),
  };

  if (result.dedupeReceiptRetentionMs < result.sourceReplayWindowMs) {
    throw new Error("dedupeReceiptRetentionMs must cover sourceReplayWindowMs");
  }
  if (
    result.gatewayReceiptRetentionMs <
    result.maxRetryWindowMs + result.restoreReconciliationWindowMs
  ) {
    throw new Error(
      "gatewayReceiptRetentionMs must cover maxRetryWindowMs plus restoreReconciliationWindowMs",
    );
  }
  if (result.eventAuditRetentionMs < result.operatorAuditWindowMs) {
    throw new Error("eventAuditRetentionMs must cover operatorAuditWindowMs");
  }

  return result;
}

/** Tests one trusted backend actor against the startup-validated role allowlist. */
export function isPrivilegedOperatorAllowed(
  config: SyncDeploymentConfig,
  role: PrivilegedOperatorRole,
  actorId: string,
): boolean {
  return actorId.length > 0 && config.operatorRoleAllowlist[role].includes(actorId);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function requirePositiveDuration(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(label + " must be a positive safe integer");
  }
  return value;
}

function requireOperatorRoleAllowlist(
  value: unknown,
): Readonly<Record<PrivilegedOperatorRole, readonly string[]>> {
  const allowlist = requireRecord(value, "operatorRoleAllowlist");
  return {
    sync_operator: requireActorIds(allowlist.sync_operator, "sync_operator"),
    sync_admin: requireActorIds(allowlist.sync_admin, "sync_admin"),
  };
}

function requireActorIds(value: unknown, role: PrivilegedOperatorRole): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(role + " allowlist must contain at least one actor ID");
  }

  const actorIds = new Set<string>();
  for (const actorId of value) {
    if (typeof actorId !== "string" || actorId.trim().length === 0) {
      throw new Error(role + " allowlist contains an invalid actor ID");
    }
    if (actorIds.has(actorId)) {
      throw new Error(role + " allowlist contains a duplicate actor ID");
    }
    actorIds.add(actorId);
  }
  return [...actorIds];
}
