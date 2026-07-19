/**
 * Trusted setup bridge from SQLite's physical-sheet registry to the Apps Script
 * control plane.
 *
 * Runtime data-plane calls can only use a registered route. This helper is the
 * matching owner-side path: callers pass the route returned by SQLite plus its
 * declared header schema, and the gateway creates or verifies that projection
 * before atomically replacing its remote allowlist.
 */

import type { RegisteredSyncSheet } from "../../storage/sync/syncRegistry.js";

/** Exact projection schema that setup must materialize in the bound spreadsheet. */
export interface RegisteredSyncProjectionDefinition {
  readonly sheet: RegisteredSyncSheet;
  readonly headers: readonly string[];
  /** Optional user-editable boolean control fields for a Sync_Conflicts tab. */
  readonly checkboxHeaders?: readonly string[];
}

/** Serializable route shape accepted by a remote setup/control-plane client. */
export interface SyncGatewayProvisionRoute {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredSyncSheet["projection"];
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly checkboxHeaders?: readonly string[];
}

/** Minimal control-plane boundary; the runtime remains independent of fetch or Google SDK types. */
export interface SyncGatewayProvisioner {
  provisionRegistry(registrations: readonly SyncGatewayProvisionRoute[]): Promise<{
    readonly registrations: readonly Omit<SyncGatewayProvisionRoute, "headers">[];
    readonly createdSheets: readonly string[];
    readonly initializedHeaders: readonly string[];
  }>;
}

/**
 * Provisions the complete SQLite-declared projection set without asking an
 * operator to copy tab names, ranges, or schema versions into Apps Script.
 *
 * The caller should invoke this after successful local registry writes and may
 * retry a failed remote call: the gateway only creates missing tabs and never
 * overwrites a nonblank, mismatched header row.
 */
export async function provisionRegisteredSyncSheets(
  gateway: SyncGatewayProvisioner,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): Promise<Awaited<ReturnType<SyncGatewayProvisioner["provisionRegistry"]>>> {
  if (definitions.length === 0) {
    throw new Error("sync gateway provisioning requires at least one SQLite projection");
  }

  const spreadsheetId = definitions[0]?.sheet.spreadsheetId;
  const physicalSheetIds = new Set<string>();
  const tabNames = new Set<string>();
  const registrations = definitions.map((definition) => {
    if (spreadsheetId === undefined || definition.sheet.spreadsheetId !== spreadsheetId) {
      throw new Error("sync gateway provisioning definitions must target one spreadsheet");
    }
    if (physicalSheetIds.has(definition.sheet.physicalSheetId)) {
      throw new Error("sync gateway provisioning cannot repeat a physical sheet ID");
    }
    if (tabNames.has(definition.sheet.tabName)) {
      throw new Error("sync gateway provisioning cannot repeat a tab name");
    }
    physicalSheetIds.add(definition.sheet.physicalSheetId);
    tabNames.add(definition.sheet.tabName);
    if (definition.headers.length === 0) {
      throw new Error("sync gateway provisioning requires declared headers");
    }
    return {
      sheetName: definition.sheet.tabName,
      registeredRange: definition.sheet.registeredRange,
      projection: definition.sheet.projection,
      schemaVersion: definition.sheet.schemaVersion,
      headers: definition.headers,
      ...(definition.checkboxHeaders === undefined ? {} : { checkboxHeaders: definition.checkboxHeaders }),
    };
  });

  return gateway.provisionRegistry(registrations);
}
