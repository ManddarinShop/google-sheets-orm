/**
 * Signed protocol for the general SQLite-authoritative sync gateway.
 *
 * It authenticates the registry-bound data plane independently from any
 * historical experiment protocol.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

/** Protocol accepted by the production-shaped Apps Script sync handler. */
export const SYNC_GATEWAY_PROTOCOL_VERSION = "typed-sheets-sync-v1" as const;

/** Operations exposed by the registry-bound sync gateway. */
export type SyncGatewayOperation =
  | "ensureRowAnchors"
  | "readSnapshot"
  | "readEffectPostcondition"
  | "applyEffects";

/** JSON payload accepted in a sync envelope. */
export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SyncJsonValue[]
  | { readonly [key: string]: SyncJsonValue };

/** Authenticated gateway request. `registeredRange` is also part of the signature. */
export interface SyncGatewayEnvelope<Payload extends SyncJsonValue = SyncJsonValue> {
  readonly protocolVersion: typeof SYNC_GATEWAY_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: SyncGatewayOperation;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sheetId: string;
  readonly registeredRange: string;
  readonly actorId: string;
  readonly bodyHash: string;
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
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalSyncJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSyncJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("sync gateway payload must contain JSON values only");
}

/** SHA-256 helper shared by envelope and effect payload verification. */
export function syncSha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Exact signing input that Apps Script verifies before opening a spreadsheet. */
export function syncGatewaySigningInput(input: Pick<
  SyncGatewayEnvelope,
  "protocolVersion" | "requestId" | "operation" | "keyId" | "issuedAt" | "expiresAt" |
  "sheetId" | "registeredRange" | "actorId" | "bodyHash"
>): string {
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
  input: Pick<
    SyncGatewayEnvelope,
    "protocolVersion" | "requestId" | "operation" | "keyId" | "issuedAt" | "expiresAt" |
    "sheetId" | "registeredRange" | "actorId" | "bodyHash"
  >,
  secret: string,
): string {
  if (secret.length === 0) throw new Error("sync gateway secret must not be empty");
  return createHmac("sha256", secret).update(syncGatewaySigningInput(input), "utf8").digest("base64url");
}

/** Creates a short-lived signed request for one registered sheet range. */
export function createSyncGatewayEnvelope<Payload extends SyncJsonValue>(
  options: CreateSyncGatewayEnvelopeOptions<Payload>,
): SyncGatewayEnvelope<Payload> {
  const issuedAt = options.issuedAt ?? Date.now();
  const expiresInMs = options.expiresInMs ?? 60_000;
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new Error("sync gateway issuedAt must be a positive safe integer");
  }
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > 10 * 60_000) {
    throw new Error("sync gateway expiry must be between 1 second and 10 minutes");
  }
  if (options.sheetId.length === 0 || options.registeredRange.length === 0) {
    throw new Error("sync gateway sheetId and registeredRange are required");
  }
  const actorId = options.actorId ?? "typed-sheets-sync-worker";
  const keyId = options.keyId ?? "typed-sheets-shared-secret-v1";
  if (actorId.length === 0 || keyId.length === 0) throw new Error("sync gateway actor and key ID are required");
  const requestId = options.requestId ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    throw new Error("sync gateway requestId must be 8-128 URL-safe characters");
  }
  const bodyHash = syncSha256Hex(canonicalSyncJson(options.payload));
  const unsigned = {
    protocolVersion: SYNC_GATEWAY_PROTOCOL_VERSION,
    requestId,
    operation: options.operation,
    keyId,
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    sheetId: options.sheetId,
    registeredRange: options.registeredRange,
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
  if (!Number.isFinite(value)) throw new Error("sync gateway payload numbers must be finite");
  return (value === 0 ? "0" : value.toString()).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
