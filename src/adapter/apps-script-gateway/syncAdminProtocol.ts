/**
 * Signed control-plane protocol for provisioning registry-bound Sheet projections.
 *
 * The SQLite service owns the declared projection routes. This separate
 * protocol lets that trusted service create or verify those routes without a
 * human copying tab names into Apps Script after every schema change.
 */

import { createHmac, randomUUID } from "node:crypto";
import { canonicalSyncJson, syncSha256Hex, type SyncJsonValue } from "./syncProtocol.js";

/** Protocol reserved for trusted setup and schema-provisioning requests. */
export const SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION = "typed-sheets-sync-admin-v1" as const;

/** Owner-controlled operations; data-plane workers cannot infer routes from them. */
export type SyncGatewayAdminOperation = "provisionRegistry";

/** Short-lived envelope accepted by the Apps Script sync control plane. */
export interface SyncGatewayAdminEnvelope<Payload extends SyncJsonValue = SyncJsonValue> {
  readonly protocolVersion: typeof SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: SyncGatewayAdminOperation;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sheetId: string;
  readonly actorId: string;
  readonly bodyHash: string;
  readonly signature: string;
  readonly payload: Payload;
}

/** Deterministic input options used by the control-plane client and tests. */
export interface CreateSyncGatewayAdminEnvelopeOptions<Payload extends SyncJsonValue> {
  readonly operation: SyncGatewayAdminOperation;
  readonly payload: Payload;
  readonly sheetId: string;
  readonly secret: string;
  readonly keyId?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly issuedAt?: number;
  readonly expiresInMs?: number;
}

/** Exact HMAC input for a control-plane request. */
export function syncGatewayAdminSigningInput(input: Pick<
  SyncGatewayAdminEnvelope,
  "protocolVersion" | "requestId" | "operation" | "keyId" | "issuedAt" | "expiresAt" |
  "sheetId" | "actorId" | "bodyHash"
>): string {
  return [
    input.protocolVersion,
    input.requestId,
    input.operation,
    input.keyId,
    String(input.issuedAt),
    String(input.expiresAt),
    input.sheetId,
    input.actorId,
    input.bodyHash,
  ].join("\n");
}

/** Computes the URL-safe HMAC that authenticates a provisioning request. */
export function signSyncGatewayAdminEnvelope(
  input: Pick<
    SyncGatewayAdminEnvelope,
    "protocolVersion" | "requestId" | "operation" | "keyId" | "issuedAt" | "expiresAt" |
    "sheetId" | "actorId" | "bodyHash"
  >,
  secret: string,
): string {
  if (secret.length === 0) throw new Error("sync gateway admin secret must not be empty");
  return createHmac("sha256", secret)
    .update(syncGatewayAdminSigningInput(input), "utf8")
    .digest("base64url");
}

/** Creates one authenticated, short-lived request to provision declared projections. */
export function createSyncGatewayAdminEnvelope<Payload extends SyncJsonValue>(
  options: CreateSyncGatewayAdminEnvelopeOptions<Payload>,
): SyncGatewayAdminEnvelope<Payload> {
  const issuedAt = options.issuedAt ?? Date.now();
  const expiresInMs = options.expiresInMs ?? 60_000;
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new Error("sync gateway admin issuedAt must be a positive safe integer");
  }
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > 10 * 60_000) {
    throw new Error("sync gateway admin expiry must be between 1 second and 10 minutes");
  }
  if (options.sheetId.length === 0) throw new Error("sync gateway admin sheetId is required");

  const actorId = options.actorId ?? "typed-sheets-sync-bootstrap";
  const keyId = options.keyId ?? "typed-sheets-shared-secret-v1";
  if (actorId.length === 0 || keyId.length === 0) {
    throw new Error("sync gateway admin actor and key ID are required");
  }
  const requestId = options.requestId ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    throw new Error("sync gateway admin requestId must be 8-128 URL-safe characters");
  }

  const bodyHash = syncSha256Hex(canonicalSyncJson(options.payload));
  const unsigned = {
    protocolVersion: SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION,
    requestId,
    operation: options.operation,
    keyId,
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    sheetId: options.sheetId,
    actorId,
    bodyHash,
  } as const;
  return {
    ...unsigned,
    signature: signSyncGatewayAdminEnvelope(unsigned, options.secret),
    payload: options.payload,
  };
}
