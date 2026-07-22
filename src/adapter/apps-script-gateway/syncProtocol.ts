/**
 * Signed protocol for the general SQLite-authoritative sync gateway.
 *
 * It authenticates the registry-bound data plane independently from any
 * historical experiment protocol.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { JAVASCRIPT_TYPE_NAMES } from "../../core/encoding/constants.js";
import {
  SYNC_GATEWAY_DEFAULTS,
  SYNC_GATEWAY_ENCODINGS,
  SYNC_GATEWAY_HASH_ALGORITHMS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  SYNC_JSON_LITERAL_TOKENS,
  type SyncGatewayOperation,
} from "./constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
} from "./errors.js";
import {
  requireSyncGatewayExpiry,
  requireSyncGatewayIssuedAt,
  requireSyncGatewayOperation,
  requireSyncGatewayRequestId,
  requireSyncGatewayText,
} from "./validation.js";
import type {
  SyncGatewayDataSigningFields,
  SyncJsonValue,
} from "./types.js";

/** Protocol accepted by the production-shaped Apps Script sync handler. */
export const SYNC_GATEWAY_PROTOCOL_VERSION = SYNC_GATEWAY_PROTOCOL_VERSIONS.DATA;
export type { SyncGatewayOperation } from "./constants.js";
export type { SyncJsonValue } from "./types.js";

/** Authenticated gateway request. `registeredRange` is also part of the signature. */
export interface SyncGatewayEnvelope<Payload extends SyncJsonValue = SyncJsonValue>
  extends SyncGatewayDataSigningFields {
  readonly protocolVersion: typeof SYNC_GATEWAY_PROTOCOL_VERSION;
  readonly signature: string;
  readonly payload: Payload;
}

/** Options that make a signed envelope deterministic in tests. */
export interface CreateSyncGatewayEnvelopeOptions<Payload extends SyncJsonValue> {
  readonly operation: SyncGatewayOperation;
  readonly payload: Payload;
  readonly sheetId: string;
  readonly registeredRange: string;
  readonly secret: string;
  readonly keyId?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly issuedAt?: number;
  readonly expiresInMs?: number;
}

/** Canonical JSON used for payload hashes and cross-runtime HMAC inputs. */
export function canonicalSyncJson(value: unknown): string {
  if (value === null) return SYNC_JSON_LITERAL_TOKENS.NULL;
  if (value === true) return SYNC_JSON_LITERAL_TOKENS.TRUE;
  if (value === false) return SYNC_JSON_LITERAL_TOKENS.FALSE;
  if (isString(value)) return JSON.stringify(value);
  if (isNumber(value)) return canonicalNumber(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalSyncJson(item)).join(",")}]`;
  if (isObject(value) && isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSyncJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new SyncGatewayProtocolError(
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_JSON_VALUE,
    "sync gateway payload must contain JSON values only",
  );
}

/** SHA-256 helper shared by envelope and effect payload verification. */
export function syncSha256Hex(value: string): string {
  return createHash(SYNC_GATEWAY_HASH_ALGORITHMS.SHA256)
    .update(value, SYNC_GATEWAY_ENCODINGS.UTF8)
    .digest("hex");
}

/** Exact signing input that Apps Script verifies before opening a spreadsheet. */
export function syncGatewaySigningInput(input: SyncGatewayDataSigningFields): string {
  return [
    input.protocolVersion,
    input.requestId,
    input.operation,
    input.keyId,
    String(input.issuedAt),
    String(input.expiresAt),
    input.sheetId,
    input.registeredRange,
    input.actorId,
    input.bodyHash,
  ].join("\n");
}

/** Computes the URL-safe HMAC signature used by the sync gateway. */
export function signSyncGatewayEnvelope(
  input: SyncGatewayDataSigningFields,
  secret: string,
): string {
  const validSecret = requireSyncGatewayText(
    secret,
    "sync gateway secret",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_SECRET,
  );
  return createHmac(SYNC_GATEWAY_HASH_ALGORITHMS.SHA256, validSecret)
    .update(syncGatewaySigningInput(input), SYNC_GATEWAY_ENCODINGS.UTF8)
    .digest(SYNC_GATEWAY_ENCODINGS.BASE64URL);
}

/** Creates a short-lived signed request for one registered sheet range. */
export function createSyncGatewayEnvelope<Payload extends SyncJsonValue>(
  options: CreateSyncGatewayEnvelopeOptions<Payload>,
): SyncGatewayEnvelope<Payload> {
  const issuedAt = requireSyncGatewayIssuedAt(options.issuedAt ?? Date.now());
  const expiresInMs = requireSyncGatewayExpiry(
    options.expiresInMs ?? SYNC_GATEWAY_DEFAULTS.EXPIRY_MS,
  );
  const sheetId = requireSyncGatewayText(
    options.sheetId,
    "sync gateway sheetId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_SHEET_ID,
  );
  const registeredRange = requireSyncGatewayText(
    options.registeredRange,
    "sync gateway registeredRange",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_REGISTERED_RANGE,
  );
  const actorId = requireSyncGatewayText(
    options.actorId ?? SYNC_GATEWAY_DEFAULTS.DATA_ACTOR_ID,
    "sync gateway actorId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_ACTOR_ID,
  );
  const keyId = requireSyncGatewayText(
    options.keyId ?? SYNC_GATEWAY_DEFAULTS.KEY_ID,
    "sync gateway keyId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_KEY_ID,
  );
  const requestId = requireSyncGatewayRequestId(options.requestId ?? randomUUID());
  const operation = requireSyncGatewayOperation(options.operation);
  const bodyHash = syncSha256Hex(canonicalSyncJson(options.payload));
  const unsigned = {
    protocolVersion: SYNC_GATEWAY_PROTOCOL_VERSION,
    requestId,
    operation,
    keyId,
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    sheetId,
    registeredRange,
    actorId,
    bodyHash,
  } as const;
  return {
    ...unsigned,
    signature: signSyncGatewayEnvelope(unsigned, options.secret),
    payload: options.payload,
  };
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.NON_FINITE_NUMBER,
      "sync gateway payload numbers must be finite",
    );
  }
  return (value === 0 ? "0" : value.toString()).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isString(value: unknown): value is string {
  return typeof value === JAVASCRIPT_TYPE_NAMES.STRING;
}

function isNumber(value: unknown): value is number {
  return typeof value === JAVASCRIPT_TYPE_NAMES.NUMBER;
}

function isObject(value: unknown): value is object {
  return typeof value === JAVASCRIPT_TYPE_NAMES.OBJECT && value !== null;
}
