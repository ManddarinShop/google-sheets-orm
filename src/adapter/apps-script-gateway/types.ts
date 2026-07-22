import type {
  SyncGatewayAdminOperation,
  SyncGatewayAdminProtocolVersion,
  SyncGatewayDataProtocolVersion,
  SyncGatewayOperation,
} from "./constants.js";

/** JSON values allowed in signed gateway payloads. */
export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SyncJsonValue[]
  | { readonly [key: string]: SyncJsonValue };

/** Fields shared by every signed data-plane and control-plane envelope. */
export interface SyncGatewaySigningFields<
  TProtocolVersion extends string = string,
  TOperation extends string = string,
> {
  readonly protocolVersion: TProtocolVersion;
  readonly requestId: string;
  readonly operation: TOperation;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sheetId: string;
  readonly actorId: string;
  readonly bodyHash: string;
}

/** Signed fields for a registry-bound data-plane request. */
export type SyncGatewayDataSigningFields = SyncGatewaySigningFields<
  SyncGatewayDataProtocolVersion,
  SyncGatewayOperation
> & {
  readonly registeredRange: string;
};

/** Signed fields for a trusted control-plane provisioning request. */
export type SyncGatewayAdminSigningFields = SyncGatewaySigningFields<
  SyncGatewayAdminProtocolVersion,
  SyncGatewayAdminOperation
>;
