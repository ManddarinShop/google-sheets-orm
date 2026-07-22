/** Protocol versions for the data and control planes. */
export const SYNC_GATEWAY_PROTOCOL_VERSIONS = {
  DATA: "typed-sheets-sync-v1",
  ADMIN: "typed-sheets-sync-admin-v1",
} as const;

export type SyncGatewayProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)[keyof typeof SYNC_GATEWAY_PROTOCOL_VERSIONS];

/** Data-plane protocol version used by signed sync requests. */
export type SyncGatewayDataProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)["DATA"];

/** Control-plane protocol version used by signed provisioning requests. */
export type SyncGatewayAdminProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)["ADMIN"];

/** Operations accepted by the registry-bound data plane. */
export const SYNC_GATEWAY_OPERATIONS = {
  ENSURE_ROW_ANCHORS: "ensureRowAnchors",
  READ_SNAPSHOT: "readSnapshot",
  READ_EFFECT_POSTCONDITION: "readEffectPostcondition",
  APPLY_EFFECTS: "applyEffects",
} as const;

export type SyncGatewayOperation =
  (typeof SYNC_GATEWAY_OPERATIONS)[keyof typeof SYNC_GATEWAY_OPERATIONS];

/** Operations reserved for trusted registry provisioning. */
export const SYNC_GATEWAY_ADMIN_OPERATIONS = {
  PROVISION_REGISTRY: "provisionRegistry",
} as const;

export type SyncGatewayAdminOperation =
  (typeof SYNC_GATEWAY_ADMIN_OPERATIONS)[keyof typeof SYNC_GATEWAY_ADMIN_OPERATIONS];

/** Shared defaults for signed gateway envelopes. */
export const SYNC_GATEWAY_DEFAULTS = {
  DATA_ACTOR_ID: "typed-sheets-sync-worker",
  ADMIN_ACTOR_ID: "typed-sheets-sync-bootstrap",
  KEY_ID: "typed-sheets-shared-secret-v1",
  EXPIRY_MS: 60_000,
  MIN_EXPIRY_MS: 1_000,
  MAX_EXPIRY_MS: 10 * 60_000,
} as const;

/** Cryptographic algorithm used by both gateway envelope types. */
export const SYNC_GATEWAY_HASH_ALGORITHMS = {
  SHA256: "sha256",
} as const;

/** Encodings used by the Node crypto boundary. */
export const SYNC_GATEWAY_ENCODINGS = {
  UTF8: "utf8",
  BASE64URL: "base64url",
} as const;

/** Canonical JSON tokens emitted for primitive literal values. */
export const SYNC_JSON_LITERAL_TOKENS = {
  NULL: "null",
  TRUE: "true",
  FALSE: "false",
} as const;

/** Request IDs must remain short and safe to carry through the gateway. */
export const SYNC_GATEWAY_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
