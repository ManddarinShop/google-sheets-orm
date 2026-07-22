/**
 * Signed control-plane protocol for provisioning registry-bound Sheet projections.
 *
 * The SQLite service owns the declared projection routes. This separate
 * protocol lets that trusted service create or verify those routes without a
 * human copying tab names into Apps Script after every schema change.
 */

import { createHmac, randomUUID } from "node:crypto";
import {
  SYNC_GATEWAY_DEFAULTS,
  SYNC_GATEWAY_ENCODINGS,
  SYNC_GATEWAY_HASH_ALGORITHMS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  type SyncGatewayAdminOperation,
} from "./constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
} from "./errors.js";
import {
  requireSyncGatewayAdminOperation,
  requireSyncGatewayExpiry,
  requireSyncGatewayIssuedAt,
  requireSyncGatewayRequestId,
  requireSyncGatewayText,
} from "./validation.js";
import { canonicalSyncJson, syncSha256Hex } from "./syncProtocol.js";
import type {
  SyncGatewayAdminSigningFields,
  SyncJsonValue,
} from "./types.js";

/** Protocol reserved for trusted setup and schema-provisioning requests. */
export const SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION = SYNC_GATEWAY_PROTOCOL_VERSIONS.ADMIN;
export type { SyncGatewayAdminOperation } from "./constants.js";

/** Owner-controlled operations; data-plane workers cannot infer routes from them. */
/** Short-lived envelope accepted by the Apps Script sync control plane. */
export interface SyncGatewayAdminEnvelope<Payload extends SyncJsonValue = SyncJsonValue>
  extends SyncGatewayAdminSigningFields {
  readonly protocolVersion: typeof SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION;
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
export function syncGatewayAdminSigningInput(input: SyncGatewayAdminSigningFields): string {
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
  input: SyncGatewayAdminSigningFields,
  secret: string,
): string {
  const validSecret = requireSyncGatewayText(
    secret,
    "sync gateway admin secret",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_SECRET,
  );
  return createHmac(SYNC_GATEWAY_HASH_ALGORITHMS.SHA256, validSecret)
    .update(syncGatewayAdminSigningInput(input), SYNC_GATEWAY_ENCODINGS.UTF8)
    .digest(SYNC_GATEWAY_ENCODINGS.BASE64URL);
}

/** Creates one authenticated, short-lived request to provision declared projections. */
export function createSyncGatewayAdminEnvelope<Payload extends SyncJsonValue>(
  options: CreateSyncGatewayAdminEnvelopeOptions<Payload>,
): SyncGatewayAdminEnvelope<Payload> {
  const issuedAt = requireSyncGatewayIssuedAt(options.issuedAt ?? Date.now());
  const expiresInMs = requireSyncGatewayExpiry(
    options.expiresInMs ?? SYNC_GATEWAY_DEFAULTS.EXPIRY_MS,
  );
  const sheetId = requireSyncGatewayText(
    options.sheetId,
    "sync gateway admin sheetId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_SHEET_ID,
  );
  const actorId = requireSyncGatewayText(
    options.actorId ?? SYNC_GATEWAY_DEFAULTS.ADMIN_ACTOR_ID,
    "sync gateway admin actorId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_ACTOR_ID,
  );
  const keyId = requireSyncGatewayText(
    options.keyId ?? SYNC_GATEWAY_DEFAULTS.KEY_ID,
    "sync gateway admin keyId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_KEY_ID,
  );
  const requestId = requireSyncGatewayRequestId(options.requestId ?? randomUUID());
  const operation = requireSyncGatewayAdminOperation(options.operation);

  const bodyHash = syncSha256Hex(canonicalSyncJson(options.payload));
  const unsigned = {
    protocolVersion: SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION,
    requestId,
    operation,
    keyId,
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    sheetId,
    actorId,
    bodyHash,
  } as const;
  return {
    ...unsigned,
    signature: signSyncGatewayAdminEnvelope(unsigned, options.secret),
    payload: options.payload,
  };
}
