/** Signed adapter tools for the registry-bound Apps Script sync gateway. */

export {
  SYNC_GATEWAY_PROTOCOL_VERSION,
  canonicalSyncJson,
  syncSha256Hex,
  syncGatewaySigningInput,
  signSyncGatewayEnvelope,
  createSyncGatewayEnvelope,
} from "./syncProtocol.js";
export type {
  SyncJsonValue,
  SyncGatewayOperation,
  SyncGatewayEnvelope,
  CreateSyncGatewayEnvelopeOptions,
} from "./syncProtocol.js";
export {
  SYNC_GATEWAY_ADMIN_PROTOCOL_VERSION,
  syncGatewayAdminSigningInput,
  signSyncGatewayAdminEnvelope,
  createSyncGatewayAdminEnvelope,
} from "./syncAdminProtocol.js";
export type {
  SyncGatewayAdminOperation,
  SyncGatewayAdminEnvelope,
  CreateSyncGatewayAdminEnvelopeOptions,
} from "./syncAdminProtocol.js";
export { AppsScriptSyncGatewayClient } from "./syncClient.js";
export {
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
} from "./errors.js";
export type {
  AppsScriptSyncGatewayClientOptions,
  SyncGatewayProvisionRegistration,
  SyncGatewayProvisionResult,
} from "./syncClient.js";
export type { SyncGatewayClientErrorCode } from "./errors.js";
