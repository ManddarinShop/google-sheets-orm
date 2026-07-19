/**
 * Public surface for the SQLite-authoritative sync foundation.
 *
 * The SQLite-authoritative sync bootstrap is explicitly service-side: it uses
 * a secret-bearing Apps Script client and must never be bundled into a browser.
 */

export * from "./core/index.js";
export * from "./storage/index.js";
export {
  AppsScriptSyncGatewayClient,
  AppsScriptSyncGatewayError,
} from "./adapter/apps-script-gateway/index.js";
export type {
  AppsScriptSyncGatewayClientOptions,
  SyncGatewayProvisionRegistration,
  SyncGatewayProvisionResult,
} from "./adapter/apps-script-gateway/index.js";
export { provisionRegisteredSyncSheets } from "./runtime/gateway/SyncGatewayBootstrap.js";
export type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisionRoute,
  SyncGatewayProvisioner,
} from "./runtime/gateway/SyncGatewayBootstrap.js";
