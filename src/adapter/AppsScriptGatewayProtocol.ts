import type {
  DeleteRowsByKeyResult,
  SheetCell,
  SheetSnapshot,
  UpdateRowsByKeyResult,
} from "./Adapter.js";

export type AppsScriptGatewayRequest =
  | { operation: "ping" }
  | { operation: "ensureSheet"; sheetName: string }
  | { operation: "initializeSheet"; sheetName: string; headers: string[] }
  | { operation: "writeHeader"; sheetName: string; headers: string[] }
  | { operation: "readSheet"; sheetName: string }
  | { operation: "appendRow"; sheetName: string; row: SheetCell[] }
  | { operation: "appendRows"; sheetName: string; rows: SheetCell[][] }
  | {
      operation: "updateRow";
      sheetName: string;
      rowNumber: number;
      row: SheetCell[];
    }
  | {
      operation: "updateRowsByKey";
      sheetName: string;
      expectedHeaders: string[];
      keyHeader: string;
      versionHeader: string;
      updates: Array<{
        id: string;
        expectedVersion: number;
        row: SheetCell[];
      }>;
    }
  | { operation: "deleteRow"; sheetName: string; rowNumber: number }
  | { operation: "deleteRows"; sheetName: string; rowNumbers: number[] }
  | {
      operation: "deleteRowsByKey";
      sheetName: string;
      expectedHeaders: string[];
      keyHeader: string;
      versionHeader: string;
      ids: string[];
      versionsById: Record<string, number>;
    };

export type AppsScriptGatewayAuthenticatedRequest =
  AppsScriptGatewayRequest & {
    secret: string;
  };

export type AppsScriptGatewayResponse = {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
} & Record<string, unknown>;

export type AppsScriptGatewayReadSheetResponse = AppsScriptGatewayResponse &
  SheetSnapshot;

export type AppsScriptGatewayDeleteRowsByKeyResponse =
  AppsScriptGatewayResponse & DeleteRowsByKeyResult;

export type AppsScriptGatewayUpdateRowsByKeyResponse =
  AppsScriptGatewayResponse & UpdateRowsByKeyResult;
