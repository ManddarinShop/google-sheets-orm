import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../core/constants.js";
import { JAVASCRIPT_TYPE_NAMES } from "../../core/encoding/constants.js";
import {
  SyncGatewayContractError,
  type SyncGatewayErrorCode,
} from "./errors.js";

/** Requires a non-empty string at a gateway contract boundary. */
export function requireSyncGatewayText(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): string {
  if (
    !isString(value) ||
    value.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throw new SyncGatewayContractError(errorCode, `${label} is required`);
  }
  return value;
}

/** Requires a positive safe integer at a gateway contract boundary. */
export function requireSyncGatewayPositiveSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): number {
  if (
    !isNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

/** Requires a non-empty list at a gateway contract boundary. */
export function requireSyncGatewayNonEmptyList<T>(
  values: readonly T[],
  label: string,
  errorCode: SyncGatewayErrorCode,
): void {
  if (values.length === EMPTY_ARRAY_LENGTH_ZERO) {
    throw new SyncGatewayContractError(errorCode, `${label} requires at least one item`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === JAVASCRIPT_TYPE_NAMES.STRING;
}

function isNumber(value: unknown): value is number {
  return typeof value === JAVASCRIPT_TYPE_NAMES.NUMBER;
}
