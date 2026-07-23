// Source module for the generated manual Apps Script gateway.

// typed-sheets - Manual Apps Script Gateway
//
// This file is the canonical Apps Script gateway template shipped with the npm
// package. The setup CLI points users to this file instead of embedding a copy.

const TYPED_SHEETS_CONFIG_PROPERTY = "typedSheetsConfig";
const TYPED_SHEETS_META_SHEET_NAME = "_typed_sheets_meta";
const TYPED_SHEETS_GATEWAY_URL = "";
const TYPED_SHEETS_INTERNAL_PREFIX = "_typed_sheets_";
const TYPED_SHEETS_DATA_SHEET_PREFIX = "_typed_sheets_data_";
const TYPED_SHEETS_META_MAPPING_KEY_PREFIX = "sheetMapping:";
const TYPED_SHEETS_META_MIGRATION_KEY_PREFIX = "projectionMigration:";
const TYPED_SHEETS_MAX_SHEET_NAME_LENGTH = 100;
const TYPED_SHEETS_TASK_QUEUE_SHEET_NAME = "_typed_sheets_task_queue";
// Apps Script executions cannot retain a document lock after they terminate.
// A processing claim older than this lease is therefore safe to return to the
// pending state on the next processor invocation.
const TYPED_SHEETS_PROCESSING_LEASE_MS = 5 * 60 * 1000;
// The processing lease also acts as the retry backoff. Once a transaction has
// exhausted this many claims, repeated timeouts must not block the queue
// forever.
const TYPED_SHEETS_MAX_QUEUE_ATTEMPTS = 3;
const TYPED_SHEETS_TASK_QUEUE_HEADERS = [
  "taskId",
  "transactionId",
  "transactionIndex",
  "sequence",
  "status",
  "operation",
  "sheetName",
  "keyHeader",
  "keyValue",
  "expectedVersion",
  "payloadJson",
  "attempts",
  "lastErrorCode",
  "lastErrorMessage",
  "createdAt",
  "updatedAt",
  "taskFingerprint",
];
const TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS =
  TYPED_SHEETS_TASK_QUEUE_HEADERS.slice(0, -1);
const TYPED_SHEETS_LEGACY_REDACTED_FINGERPRINT_PREFIX =
  "legacy-redacted:";
const TYPED_SHEETS_QUEUE_OPERATIONS = [
  "initializeSystemSheets",
  "enqueueTasks",
  "processTaskQueue",
  "readCanonicalSheet",
];
const TYPED_SHEETS_LEGACY_DIRECT_OPERATIONS = [
  "ensureSheet",
  "initializeSheet",
  "writeHeader",
  "appendRow",
  "appendRows",
  "updateRow",
  "updateRowsByKey",
  "deleteRow",
  "deleteRows",
  "deleteRowsByKey",
];

/**
 * Generates and stores the gateway config for this spreadsheet.
 *
 * @returns {object} The typed-sheets config to paste into .typed-sheets.json.
 */
