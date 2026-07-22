import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../core/constants.js";
import { JAVASCRIPT_TYPE_NAMES } from "../../core/encoding/constants.js";
import {
  SYNC_GATEWAY_ADMIN_OPERATIONS,
  SYNC_GATEWAY_DEFAULTS,
  SYNC_GATEWAY_OPERATIONS,
  SYNC_GATEWAY_REQUEST_ID_PATTERN,
  type SyncGatewayAdminOperation,
  type SyncGatewayOperation,
} from "./constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
  type SyncGatewayProtocolErrorCode,
} from "./errors.js";

/** Requires a non-empty text value for a protocol field. */
export function requireSyncGatewayText(
  value: unknown,
  label: string,
  errorCode: SyncGatewayProtocolErrorCode,
): string {
  if (!isString(value) || value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new SyncGatewayProtocolError(errorCode, `${label} is required`);
  }
  return value;
}

/** Requires a positive safe integer for a protocol timestamp. */
export function requireSyncGatewayIssuedAt(value: unknown): number {
  if (
    !isNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_ISSUED_AT,
      "sync gateway issuedAt must be a positive safe integer",
    );
  }
  return value;
}

/** Requires an expiry duration within the protocol's bounded window. */
export function requireSyncGatewayExpiry(value: unknown): number {
  if (
    !isNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < SYNC_GATEWAY_DEFAULTS.MIN_EXPIRY_MS ||
    value > SYNC_GATEWAY_DEFAULTS.MAX_EXPIRY_MS
  ) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_EXPIRY,
      "sync gateway expiry must be between 1 second and 10 minutes",
    );
  }
  return value;
}

/** Requires a request ID accepted by both gateway implementations. */
export function requireSyncGatewayRequestId(value: unknown): string {
  const requestId = requireSyncGatewayText(
    value,
    "sync gateway requestId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_REQUEST_ID,
  );
  if (!SYNC_GATEWAY_REQUEST_ID_PATTERN.test(requestId)) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_REQUEST_ID,
      "sync gateway requestId must be 8-128 URL-safe characters",
    );
  }
  return requestId;
}

/** Requires a data-plane operation from the closed protocol set. */
export function requireSyncGatewayOperation(value: unknown): SyncGatewayOperation {
  if (!isString(value) || !isSyncGatewayOperation(value)) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_OPERATION,
      "sync gateway operation is not supported",
    );
  }
  return value;
}

/** Requires a control-plane operation from the closed protocol set. */
export function requireSyncGatewayAdminOperation(
  value: unknown,
): SyncGatewayAdminOperation {
  if (!isString(value) || !isSyncGatewayAdminOperation(value)) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_ADMIN_OPERATION,
      "sync gateway admin operation is not supported",
    );
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === JAVASCRIPT_TYPE_NAMES.STRING;
}

function isNumber(value: unknown): value is number {
  return typeof value === JAVASCRIPT_TYPE_NAMES.NUMBER;
}

function isSyncGatewayOperation(value: string): value is SyncGatewayOperation {
  return Object.values(SYNC_GATEWAY_OPERATIONS).includes(
    value as SyncGatewayOperation,
  );
}

function isSyncGatewayAdminOperation(
  value: string,
): value is SyncGatewayAdminOperation {
  return Object.values(SYNC_GATEWAY_ADMIN_OPERATIONS).includes(
    value as SyncGatewayAdminOperation,
  );
}
