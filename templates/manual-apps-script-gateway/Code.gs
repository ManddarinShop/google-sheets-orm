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
const TYPED_SHEETS_MAX_SHEET_NAME_LENGTH = 100;
const TYPED_SHEETS_TASK_QUEUE_SHEET_NAME = "_typed_sheets_task_queue";
// Apps Script executions cannot retain a document lock after they terminate.
// A processing claim older than this lease is therefore safe to return to the
// pending state on the next processor invocation.
const TYPED_SHEETS_PROCESSING_LEASE_MS = 5 * 60 * 1000;
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
function setupTypedSheets() {
  const config = createTypedSheetsConfig_();
  const configJson = JSON.stringify(config, null, 2);

  Logger.log(configJson);

  return config;
}

/**
 * Handles typed-sheets gateway HTTP requests under the document lock.
 *
 * @param {object} e - Apps Script Web App event with the JSON request body.
 * @returns {TextOutput} JSON response for the requested gateway operation.
 */
function doPost(e) {
  try {
    const request = parseRequest_(e);
    const config = getTypedSheetsConfig_();

    if (!config || request.secret !== config.auth.gatewaySecret) {
      return error_("unauthorized", "Invalid gateway secret");
    }

    const operation = validateOperation_(request);
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
      const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

      if (operation === "ping") {
        return json_({
          ok: true,
          locked: true,
          spreadsheetId: spreadsheet.getId(),
          sheetName: spreadsheet.getActiveSheet().getName(),
        });
      }

      if (operation === "initializeSystemSheets") {
        return json_({
          ok: true,
          systemSheets: initializeSystemSheets_(spreadsheet, request),
        });
      }

      if (operation === "enqueueTasks") {
        return json_(enqueueTasks_(spreadsheet, request));
      }

      if (operation === "processTaskQueue") {
        return json_(processTaskQueue_(spreadsheet, request));
      }

      if (operation === "readCanonicalSheet") {
        return json_(readCanonicalSheet_(spreadsheet, request));
      }

      if (operation === "readSheet") {
        return json_(readSheet_(spreadsheet, request));
      }

      // Legacy direct-write operations remain for existing gateway configs
      // until repository writes are fully routed through the task queue.
      if (operation === "ensureSheet") {
        ensureSheet_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "initializeSheet") {
        initializeSheet_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "writeHeader") {
        writeHeader_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "appendRow") {
        appendRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "appendRows") {
        appendRows_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "updateRow") {
        updateRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "updateRowsByKey") {
        return json_(updateRowsByKey_(spreadsheet, request));
      }

      if (operation === "deleteRow") {
        deleteRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRows") {
        deleteRows_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRowsByKey") {
        return json_(deleteRowsByKey_(spreadsheet, request));
      }

      return error_("unknown_operation", "Unknown operation: " + operation);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return error_(
      error && error.code ? error.code : "internal_error",
      error && error.message ? error.message : String(error),
    );
  }
}

function parseRequest_(e) {
  try {
    const request = JSON.parse((e.postData && e.postData.contents) || "{}");

    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw gatewayError_("invalid_request", "Request body must be an object");
    }

    return request;
  } catch (error) {
    if (error && error.code) {
      throw error;
    }

    throw gatewayError_("invalid_json", "Request body must be valid JSON");
  }
}

function validateOperation_(request) {
  const operation = requireString_(request.operation, "operation");

  if (
    operation !== "ping"
      && operation !== "readSheet"
      && TYPED_SHEETS_QUEUE_OPERATIONS.indexOf(operation) === -1
      && TYPED_SHEETS_LEGACY_DIRECT_OPERATIONS.indexOf(operation) === -1
  ) {
    throw gatewayError_("unknown_operation", "Unknown operation: " + operation);
  }

  if (operation === "ping") {
    return operation;
  }

  if (operation === "enqueueTasks") {
    requireQueueTasks_(request.tasks, "tasks");
    return operation;
  }

  if (operation === "processTaskQueue") {
    requireProcessTaskQueueOptions_(request);
    return operation;
  }

  if (operation === "initializeSystemSheets") {
    requireString_(request.sheetName, "sheetName");
    requireStringArray_(request.headers, "headers");
    return operation;
  }

  if (operation === "readSheet" || operation === "readCanonicalSheet") {
    requireString_(request.sheetName, "sheetName");
    return operation;
  }

  // Legacy direct-write validation stays isolated from the queued write model.
  requireString_(request.sheetName, "sheetName");

  if (operation === "initializeSheet" || operation === "writeHeader") {
    requireStringArray_(request.headers, "headers");
  }

  if (operation === "appendRow") {
    requireSheetCellArray_(request.row, "row");
  }

  if (operation === "appendRows") {
    requireSheetCellRows_(request.rows, "rows");
  }

  if (operation === "updateRow") {
    requirePositiveInteger_(request.rowNumber, "rowNumber");
    requireSheetCellArray_(request.row, "row");
  }

  if (operation === "updateRowsByKey") {
    requireStringArray_(request.expectedHeaders, "expectedHeaders");
    requireString_(request.keyHeader, "keyHeader");
    requireString_(request.versionHeader, "versionHeader");
    requireUpdateRows_(request.updates, "updates");
  }

  if (operation === "deleteRow") {
    requirePositiveInteger_(request.rowNumber, "rowNumber");
  }

  if (operation === "deleteRows") {
    requirePositiveIntegerArray_(request.rowNumbers, "rowNumbers");
  }

  if (operation === "deleteRowsByKey") {
    requireStringArray_(request.expectedHeaders, "expectedHeaders");
    requireString_(request.keyHeader, "keyHeader");
    requireString_(request.versionHeader, "versionHeader");
    requireStringArray_(request.ids, "ids");
    requireNumberRecord_(request.versionsById, "versionsById");
  }

  return operation;
}

function ensureSheet_(spreadsheet, request) {
  const sheetName = requireString_(request.sheetName, "sheetName");
  const existing = spreadsheet.getSheetByName(sheetName);

  if (existing) {
    return;
  }

  spreadsheet.insertSheet(sheetName);
}

function initializeSheet_(spreadsheet, request) {
  const sheetName = requireString_(request.sheetName, "sheetName");
  const headers = requireStringArray_(request.headers, "headers");
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * Creates hidden/protected system sheets for a logical repository table.
 *
 * The canonical sheet stores trusted row state while the visible sheet remains
 * a projection. Protection is best-effort because Apps Script can deny it for
 * some spreadsheet or account configurations, and Sheet owners can still edit
 * protected sheets. Creation still succeeds and logs that protection could not
 * be applied.
 */
function initializeSystemSheets_(spreadsheet, request) {
  const logicalSheetName = requireProjectionSheetName_(
    request.sheetName,
    "sheetName",
  );
  const headers = requireStringArray_(request.headers, "headers");
  assertExpectedHeaders_(headers, headers, "projection initialization");
  const canonicalSheetName = getOrCreateCanonicalSheetName_(
    spreadsheet,
    logicalSheetName,
  );

  ensureProjectionSheet_(spreadsheet, logicalSheetName, headers);
  ensureInternalSheet_(spreadsheet, canonicalSheetName, headers);
  migrateProjectionToCanonicalIfNeeded_(
    spreadsheet,
    logicalSheetName,
    canonicalSheetName,
    headers,
  );
  ensureTaskQueueSheet_(spreadsheet);

  return {
    logicalSheetName: logicalSheetName,
    canonicalSheetName: canonicalSheetName,
    projectionSheetName: logicalSheetName,
    taskQueueSheetName: TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
  };
}

/**
 * Seeds an empty canonical sheet from an existing direct-write projection.
 * This one-time copy preserves legacy rows before queued processing takes
 * ownership of the canonical state.
 */
function migrateProjectionToCanonicalIfNeeded_(
  spreadsheet,
  logicalSheetName,
  canonicalSheetName,
  headers,
) {
  const projectionSheet = getSheet_(spreadsheet, logicalSheetName);
  const canonicalSheet = getSheet_(spreadsheet, canonicalSheetName);

  if (canonicalSheet.getLastRow() > 1) {
    return;
  }

  const projectionLastRow = projectionSheet.getLastRow();

  if (projectionLastRow <= 1) {
    return;
  }

  const projectionLastColumn = projectionSheet.getLastColumn();
  const projectionHeaders = projectionSheet
    .getRange(1, 1, 1, projectionLastColumn)
    .getValues()[0]
    .map(function(value) {
      return String(value);
    });

  assertExpectedHeaders_(projectionHeaders, headers, "canonical migration");

  const rows = projectionSheet
    .getRange(2, 1, projectionLastRow - 1, headers.length)
    .getValues()
    .map(function(row) {
      return row.map(toSheetCell_);
    });

  canonicalSheet
    .getRange(2, 1, rows.length, headers.length)
    .setValues(rows);
}

/**
 * Appends one transaction worth of write tasks to the durable internal queue.
 *
 * The caller supplies stable task ids and transaction ids. The gateway assigns
 * monotonic sequence values under the document lock so processors can replay
 * write intent in enqueue order.
 */
function enqueueTasks_(spreadsheet, request) {
  const tasks = requireQueueTasks_(request.tasks, "tasks");
  const queueSheet = ensureTaskQueueSheet_(spreadsheet);
  const queueState = readTaskQueueState_(queueSheet);
  const now = new Date().toISOString();
  const seenTaskIds = Object.create(null);
  const rows = [];
  const enqueuedTasks = [];

  tasks.forEach(function(task) {
    if (seenTaskIds[task.taskId]) {
      throw gatewayError_(
        "invalid_request",
        "tasks must not contain duplicate taskId values",
      );
    }

    const taskWithFingerprint = {
      ...task,
      taskFingerprint: createTaskFingerprint_(task),
    };
    const existingTask = queueState.tasksById[taskWithFingerprint.taskId];

    if (existingTask && isSameQueuedTask_(existingTask, taskWithFingerprint)) {
      enqueuedTasks.push({
        taskId: taskWithFingerprint.taskId,
        sequence: existingTask.sequence,
      });
      seenTaskIds[taskWithFingerprint.taskId] = true;
      return;
    }

    if (existingTask) {
      throw gatewayError_(
        "duplicate_task",
        "Task already exists: " + taskWithFingerprint.taskId,
      );
    }

    seenTaskIds[taskWithFingerprint.taskId] = true;

    const sequence = queueState.maxSequence + rows.length + 1;

    rows.push([
      taskWithFingerprint.taskId,
      taskWithFingerprint.transactionId,
      taskWithFingerprint.transactionIndex,
      sequence,
      "pending",
      taskWithFingerprint.operation,
      taskWithFingerprint.sheetName,
      taskWithFingerprint.keyHeader,
      taskWithFingerprint.keyValue,
      taskWithFingerprint.expectedVersion === null
        ? ""
        : taskWithFingerprint.expectedVersion,
      taskWithFingerprint.payloadJson,
      0,
      "",
      "",
      now,
      now,
      taskWithFingerprint.taskFingerprint,
    ]);
    enqueuedTasks.push({
      taskId: taskWithFingerprint.taskId,
      sequence: sequence,
    });
  });

  if (rows.length > 0) {
    queueSheet
      .getRange(
        queueSheet.getLastRow() + 1,
        1,
        rows.length,
        TYPED_SHEETS_TASK_QUEUE_HEADERS.length,
      )
      .setValues(rows);
  }

  return {
    ok: true,
    tasks: enqueuedTasks,
  };
}

function ensureTaskQueueSheet_(spreadsheet) {
  const existingQueueSheet = spreadsheet.getSheetByName(
    TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
  );

  // Queue schema migration must happen before ensureInternalSheet_ validates
  // the current header. Otherwise an existing 16-column queue is rejected as
  // drift before the fingerprint column can be appended.
  if (
    existingQueueSheet
    && !isHeaderRowEmpty_(existingQueueSheet)
    && isLegacyTaskQueueHeader_(readHeaderRow_(existingQueueSheet))
  ) {
    migrateLegacyTaskQueueSheet_(existingQueueSheet);
  }

  ensureInternalSheet_(
    spreadsheet,
    TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
    TYPED_SHEETS_TASK_QUEUE_HEADERS,
  );

  const queueSheet = getSheet_(
    spreadsheet,
    TYPED_SHEETS_TASK_QUEUE_SHEET_NAME,
  );
  const headerValues = queueSheet
    .getRange(1, 1, 1, TYPED_SHEETS_TASK_QUEUE_HEADERS.length)
    .getValues()[0]
    .map(function(value) {
      return String(value);
    });

  if (isLegacyTaskQueueHeader_(headerValues)) {
    migrateLegacyTaskQueueSheet_(queueSheet);
    headerValues[TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.length] =
      "taskFingerprint";
  }

  assertExpectedHeaders_(
    headerValues,
    TYPED_SHEETS_TASK_QUEUE_HEADERS,
    "enqueueTasks",
  );

  // A previous migration can stop after writing the new header but before
  // backfilling every row. Resume that work on every queue access so a blank
  // fingerprint never becomes a permanent redacted-task replay failure.
  backfillMissingTaskFingerprints_(queueSheet);

  return queueSheet;
}

function isLegacyTaskQueueHeader_(headerValues) {
  return TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.every(function(header, index) {
    return headerValues[index] === header;
  }) && (
    headerValues[TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.length] === ""
    || headerValues[TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.length] === null
    || headerValues[TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.length] === undefined
  );
}

/**
 * Appends the fingerprint column to a pre-fingerprint queue without changing
 * existing task rows. Legacy rows whose payload was already redacted retain a
 * task-id-only compatibility marker because their original payload is gone.
 */
function migrateLegacyTaskQueueSheet_(queueSheet) {
  const fingerprintColumn = TYPED_SHEETS_TASK_QUEUE_HEADERS.length;

  queueSheet
    .getRange(1, fingerprintColumn, 1, 1)
    .setValues([["taskFingerprint"]]);

  const lastRow = queueSheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  const legacyRows = queueSheet
    .getRange(2, 1, lastRow - 1, TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.length)
    .getValues();
  const fingerprints = legacyRows.map(function(row) {
    return [createLegacyTaskFingerprint_(row)];
  });

  queueSheet
    .getRange(2, fingerprintColumn, fingerprints.length, 1)
    .setValues(fingerprints);
}

function backfillMissingTaskFingerprints_(queueSheet) {
  const lastRow = queueSheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  const fingerprintColumn = TYPED_SHEETS_TASK_QUEUE_HEADERS.length;
  const rows = queueSheet
    .getRange(2, 1, lastRow - 1, fingerprintColumn)
    .getValues();
  let hasMissingFingerprint = false;
  const fingerprints = rows.map(function(row) {
    const existingFingerprint = String(
      row[fingerprintColumn - 1] || "",
    );

    const hasLegacyTaskFields = row
      .slice(1, TYPED_SHEETS_LEGACY_TASK_QUEUE_HEADERS.length)
      .some(function(value) {
        return value !== "" && value !== null && value !== undefined;
      });

    // Ignore malformed/incomplete rows. Normal queue parsing will report them
    // as invalid, but migration must not expand an unrelated short row just
    // because the queue header has 17 columns.
    if (!hasLegacyTaskFields) {
      return [existingFingerprint];
    }

    if (existingFingerprint !== "") {
      return [existingFingerprint];
    }

    hasMissingFingerprint = true;
    return [createLegacyTaskFingerprint_(row)];
  });

  if (hasMissingFingerprint) {
    queueSheet
      .getRange(2, fingerprintColumn, fingerprints.length, 1)
      .setValues(fingerprints);
  }
}

function createLegacyTaskFingerprint_(row) {
  const taskId = String(row[0] || "");
  const status = String(row[4] || "");
  const payloadJson = String(row[10] || "");

  if (taskId === "") {
    return "";
  }

  if (status === "done" && isRedactedTaskPayload_(payloadJson)) {
    return TYPED_SHEETS_LEGACY_REDACTED_FINGERPRINT_PREFIX + taskId;
  }

  return createTaskFingerprint_({
    taskId: taskId,
    transactionId: String(row[1] || ""),
    transactionIndex: Number(row[2]),
    operation: String(row[5] || ""),
    sheetName: String(row[6] || ""),
    keyHeader: String(row[7] || ""),
    keyValue: String(row[8] || ""),
    expectedVersion: row[9] === "" || row[9] === null ? null : Number(row[9]),
    payloadJson: payloadJson,
  });
}

function isRedactedTaskPayload_(payloadJson) {
  try {
    const payload = JSON.parse(payloadJson);

    return payload
      && payload.redacted === true
      && Object.keys(payload).length === 1;
  } catch (error) {
    return false;
  }
}

function readTaskQueueState_(queueSheet) {
  const lastRow = queueSheet.getLastRow();
  const state = {
    maxSequence: 0,
    tasksById: Object.create(null),
  };

  if (lastRow < 2) {
    return state;
  }

  const taskIdIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("taskId");
  const transactionIdIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("transactionId");
  const transactionIndexIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("transactionIndex");
  const sequenceIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("sequence");
  const statusIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("status");
  const operationIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("operation");
  const sheetNameIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("sheetName");
  const keyHeaderIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("keyHeader");
  const keyValueIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("keyValue");
  const expectedVersionIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("expectedVersion");
  const payloadJsonIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("payloadJson");
  const taskFingerprintIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("taskFingerprint");
  const rows = queueSheet
    .getRange(
      2,
      1,
      lastRow - 1,
      TYPED_SHEETS_TASK_QUEUE_HEADERS.length,
    )
    .getValues();

  rows.forEach(function(row) {
    const taskId = String(row[taskIdIndex] || "");
    const sequence = Number(row[sequenceIndex]);

    if (taskId !== "") {
      const task = {
        taskId: taskId,
        transactionId: String(row[transactionIdIndex] || ""),
        transactionIndex: Number(row[transactionIndexIndex]),
        sequence: sequence,
        status: String(row[statusIndex] || ""),
        operation: String(row[operationIndex] || ""),
        sheetName: String(row[sheetNameIndex] || ""),
        keyHeader: String(row[keyHeaderIndex] || ""),
        keyValue: String(row[keyValueIndex] || ""),
        expectedVersion: row[expectedVersionIndex] === ""
          || row[expectedVersionIndex] === null
          ? null
          : Number(row[expectedVersionIndex]),
        payloadJson: String(row[payloadJsonIndex] || ""),
        taskFingerprint: String(row[taskFingerprintIndex] || ""),
      };

      assertStoredTaskFingerprint_(task);

      state.tasksById[taskId] = task;
    }

    if (Number.isFinite(sequence) && sequence > state.maxSequence) {
      state.maxSequence = sequence;
    }
  });

  return state;
}

function isSameQueuedTask_(existingTask, task) {
  if (
    existingTask.taskFingerprint
      === TYPED_SHEETS_LEGACY_REDACTED_FINGERPRINT_PREFIX + existingTask.taskId
  ) {
    return existingTask.status === "done";
  }

  return existingTask.taskFingerprint === task.taskFingerprint;
}

/**
 * Processes pending queue transaction groups into canonical sheets.
 *
 * This processor keeps the document lock for the full claim, apply, and status
 * update cycle. It applies complete pending groups in sequence order, rewrites
 * affected canonical sheets in bulk, and recovers processing claims whose
 * lease expired after an interrupted execution.
 */
function processTaskQueue_(spreadsheet, request) {
  const options = requireProcessTaskQueueOptions_(request);
  const queueSheet = ensureTaskQueueSheet_(spreadsheet);
  const queuedTasks = readQueuedTasks_(queueSheet);
  const now = new Date();
  const result = {
    ok: true,
    processedTransactions: 0,
    failedTransactions: 0,
    processedTasks: 0,
    failedTasks: 0,
    remainingPendingTasks: 0,
  };

  // Reconcile stale claims before selecting new work. Recovery is performed
  // for the complete transaction so a partial status update cannot leave a
  // permanently incomplete done/pending group.
  const recoveryResult = reconcileStaleProcessingTransactions_(
    spreadsheet,
    queueSheet,
    queuedTasks,
    now,
    options.maxTransactions,
  );
  result.processedTransactions += recoveryResult.processedTransactions;
  result.failedTransactions += recoveryResult.failedTransactions;
  result.processedTasks += recoveryResult.processedTasks;
  result.failedTasks += recoveryResult.failedTasks;

  const remainingTransactionBudget = Math.max(
    0,
    options.maxTransactions - recoveryResult.recoveredTransactions,
  );
  const pendingGroups = groupPendingTasksByTransaction_(queuedTasks)
    .slice(0, remainingTransactionBudget);
  const processingStartedAt = now.toISOString();

  pendingGroups.forEach(function(group) {
    markQueueTasks_(queueSheet, group.tasks, {
      status: "processing",
      updatedAt: processingStartedAt,
    });

    try {
      applyQueueTransaction_(spreadsheet, group.tasks);
    } catch (error) {
      const code = error && error.code ? error.code : "internal_error";
      const message = error && error.message ? error.message : String(error);

      markQueueTasks_(queueSheet, group.tasks, {
        status: "failed",
        lastErrorCode: code,
        lastErrorMessage: message,
        updatedAt: new Date().toISOString(),
      });

      result.failedTransactions += 1;
      result.failedTasks += group.tasks.length;
      return;
    }

    try {
      // Keep the claim in processing if this status write is interrupted.
      // The canonical write already happened, so the next processor run must
      // reconcile the postcondition instead of treating it as a normal apply
      // failure and permanently dead-lettering the transaction.
      markQueueTasks_(queueSheet, group.tasks, {
        status: "done",
        payloadJson: JSON.stringify({ redacted: true }),
        lastErrorCode: "",
        lastErrorMessage: "",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      recordQueueCompletionFailure_(queueSheet, group.tasks, error);
      return;
    }

    result.processedTransactions += 1;
    result.processedTasks += group.tasks.length;
  });

  result.remainingPendingTasks = readQueuedTasks_(queueSheet).filter(function(task) {
    return task.status === "pending";
  }).length;

  return result;
}

function recordQueueCompletionFailure_(queueSheet, tasks, error) {
  const message = error && error.message ? error.message : String(error);

  try {
    // Do not change status here. This best-effort diagnostic preserves
    // processing claims, including partially updated claims, for stale
    // recovery on a later invocation.
    markQueueTasks_(queueSheet, tasks, {
      lastErrorCode: "completion_status_unconfirmed",
      lastErrorMessage:
        "Canonical transaction applied, but completion status was not recorded: "
        + message,
      updatedAt: new Date().toISOString(),
    });
  } catch (diagnosticError) {
    // The queue write itself may be the failing operation. Leaving the claim
    // untouched is still safer than marking canonical data as failed.
  }
}

/**
 * Reconciles expired processing claims at transaction granularity. A complete
 * postcondition match is marked done, an unapplied group is returned to
 * pending, and an ambiguous or partial result is failed conservatively.
 */
function reconcileStaleProcessingTransactions_(
  spreadsheet,
  queueSheet,
  queuedTasks,
  now,
  maxTransactions,
) {
  const nowMs = now.getTime();
  const recoveredAt = now.toISOString();
  const result = {
    processedTransactions: 0,
    failedTransactions: 0,
    processedTasks: 0,
    failedTasks: 0,
    recoveredTransactions: 0,
  };
  const canonicalTables = Object.create(null);

  const groups = groupTasksByTransaction_(queuedTasks);

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];

    if (group.allTerminal) {
      continue;
    }

    // A pending group is the earliest non-terminal work and must be allowed
    // to run before any later stale claim is reconciled.
    if (group.allPending || result.recoveredTransactions >= maxTransactions) {
      break;
    }

    const hasStaleTask = group.tasks.some(function(task) {
      return isStaleProcessingTask_(task, nowMs);
    });

    if (!hasStaleTask) {
      break;
    }

    let reconciliation;

    try {
      reconciliation = reconcileTransactionPostconditions_(
        spreadsheet,
        group.tasks,
        canonicalTables,
      );
    } catch (error) {
      reconciliation = {
        status: "failed",
        errorCode: error && error.code ? error.code : "recovery_error",
        errorMessage: error && error.message
          ? error.message
          : String(error),
      };
    }

    if (reconciliation.status === "done") {
      markQueueTasks_(queueSheet, group.tasks, {
        status: "done",
        payloadJson: JSON.stringify({ redacted: true }),
        lastErrorCode: "",
        lastErrorMessage: "",
        updatedAt: recoveredAt,
      });

      group.tasks.forEach(function(task) {
        task.status = "done";
        task.payloadJson = JSON.stringify({ redacted: true });
        task.updatedAt = recoveredAt;
      });
      result.processedTransactions += 1;
      result.processedTasks += group.tasks.length;
      result.recoveredTransactions += 1;
      continue;
    }

    if (reconciliation.status === "pending") {
      markQueueTasks_(queueSheet, group.tasks, {
        status: "pending",
        lastErrorCode: "stale_processing_recovered",
        lastErrorMessage: "Recovered an unapplied transaction claim",
        updatedAt: recoveredAt,
      });

      group.tasks.forEach(function(task) {
        task.status = "pending";
        task.updatedAt = recoveredAt;
      });
      break;
    }

    markQueueTasks_(queueSheet, group.tasks, {
      status: "failed",
      lastErrorCode: reconciliation.errorCode || "partial_apply",
      lastErrorMessage: reconciliation.errorMessage
        || "Transaction postconditions are ambiguous; manual recovery is required",
      updatedAt: recoveredAt,
    });

    group.tasks.forEach(function(task) {
      task.status = "failed";
      task.updatedAt = recoveredAt;
    });
    result.failedTransactions += 1;
    result.failedTasks += group.tasks.length;
    result.recoveredTransactions += 1;
  }

  return result;
}

function isStaleProcessingTask_(task, nowMs) {
  if (task.status !== "processing") {
    return false;
  }

  const updatedAtMs = Date.parse(task.updatedAt);

  return !Number.isFinite(updatedAtMs)
    || nowMs - updatedAtMs >= TYPED_SHEETS_PROCESSING_LEASE_MS;
}

function readQueuedTasks_(queueSheet) {
  const lastRow = queueSheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const rows = queueSheet
    .getRange(
      2,
      1,
      lastRow - 1,
      TYPED_SHEETS_TASK_QUEUE_HEADERS.length,
    )
    .getValues();

  return rows.map(function(row, index) {
    return parseQueuedTaskRow_(row, index + 2);
  }).sort(function(left, right) {
    return left.sequence - right.sequence
      || left.transactionIndex - right.transactionIndex;
  });
}

function parseQueuedTaskRow_(row, rowNumber) {
  const task = {
    rowNumber: rowNumber,
    taskId: String(row[0] || ""),
    transactionId: String(row[1] || ""),
    transactionIndex: Number(row[2]),
    sequence: Number(row[3]),
    status: String(row[4] || ""),
    operation: String(row[5] || ""),
    sheetName: String(row[6] || ""),
    keyHeader: String(row[7] || ""),
    keyValue: String(row[8] || ""),
    expectedVersion: row[9] === "" || row[9] === null ? null : Number(row[9]),
    payloadJson: String(row[10] || ""),
    attempts: Number(row[11] || 0),
    updatedAt: String(row[15] || ""),
    taskFingerprint: String(row[16] || ""),
  };

  if (
    task.taskId === ""
    || task.transactionId === ""
    || !Number.isInteger(task.transactionIndex)
    || task.transactionIndex < 0
    || !Number.isInteger(task.sequence)
    || task.sequence < 1
    || ["pending", "processing", "done", "failed"].indexOf(task.status) === -1
    || ["insert", "update", "delete"].indexOf(task.operation) === -1
    || task.sheetName === ""
    || task.keyHeader === ""
    || task.keyValue === ""
    || (task.operation === "insert" && task.expectedVersion !== null)
    || (task.operation !== "insert" && !Number.isFinite(task.expectedVersion))
  ) {
    throw gatewayError_(
      "invalid_task",
      "Invalid task queue row at " + rowNumber,
    );
  }

  assertStoredTaskFingerprint_(task);

  return task;
}

function assertStoredTaskFingerprint_(task) {
  // A completed task intentionally redacts payloadJson. Its stored
  // fingerprint remains the immutable identity, but it cannot be recomputed
  // after the payload has been removed. If a migration stopped after adding
  // the column, use the durable task-id marker so the migration can resume.
  if (task.status === "done" && isRedactedTaskPayload_(task.payloadJson)) {
    if (task.taskFingerprint === "") {
      task.taskFingerprint =
        TYPED_SHEETS_LEGACY_REDACTED_FINGERPRINT_PREFIX + task.taskId;
    }

    return;
  }

  if (task.taskFingerprint === "") {
    task.taskFingerprint = createTaskFingerprint_(task);
    return;
  }

  const legacyMarker =
    TYPED_SHEETS_LEGACY_REDACTED_FINGERPRINT_PREFIX + task.taskId;

  if (task.taskFingerprint === legacyMarker) {
    if (task.status !== "done" || !isRedactedTaskPayload_(task.payloadJson)) {
      throw gatewayError_(
        "invalid_task",
        "Legacy redacted fingerprint is only valid for done tasks: "
          + task.taskId,
      );
    }

    return;
  }

  const expectedFingerprint = createTaskFingerprint_(task);

  if (task.taskFingerprint !== expectedFingerprint) {
    throw gatewayError_(
      "invalid_task",
      "Task fingerprint mismatch: " + task.taskId
        + " stored=" + task.taskFingerprint
        + " expected=" + expectedFingerprint,
    );
  }
}

function groupPendingTasksByTransaction_(queuedTasks) {
  const pendingGroups = [];

  groupTasksByTransaction_(queuedTasks).some(function(group) {
    if (group.allTerminal) {
      return false;
    }

    if (!group.allPending) {
      return true;
    }

    pendingGroups.push(group);
    return false;
  });

  return pendingGroups;
}

function groupTasksByTransaction_(queuedTasks) {
  const groupsById = Object.create(null);
  const groups = [];

  queuedTasks.forEach(function(task) {
    if (!groupsById[task.transactionId]) {
      groupsById[task.transactionId] = {
        transactionId: task.transactionId,
        firstSequence: task.sequence,
        allPending: true,
        allTerminal: true,
        tasks: [],
      };
      groups.push(groupsById[task.transactionId]);
    }

    if (task.status !== "pending") {
      groupsById[task.transactionId].allPending = false;
    }

    if (task.status !== "done" && task.status !== "failed") {
      groupsById[task.transactionId].allTerminal = false;
    }

    groupsById[task.transactionId].firstSequence = Math.min(
      groupsById[task.transactionId].firstSequence,
      task.sequence,
    );
    groupsById[task.transactionId].tasks.push(task);
  });

  groups.forEach(function(group) {
    group.tasks.sort(function(left, right) {
      return left.transactionIndex - right.transactionIndex
        || left.sequence - right.sequence;
    });
  });

  return groups.sort(function(left, right) {
    return left.firstSequence - right.firstSequence;
  });
}

/**
 * Checks each same-key task chain against the transaction's initial and final
 * states. Reading one canonical table per sheet avoids an Apps Script read for
 * every task while preserving transactionIndex ordering during recovery.
 */
function reconcileTransactionPostconditions_(
  spreadsheet,
  tasks,
  canonicalTables,
) {
  const tables = readCanonicalTablesForTransaction_(
    spreadsheet,
    tasks,
    canonicalTables,
  );
  const chains = groupTasksByTarget_(tasks);
  let appliedChains = 0;
  let unappliedChains = 0;
  let ambiguousOutcome = null;

  chains.forEach(function(chain) {
    if (chain.some(function(task) { return task.status === "failed"; })) {
      ambiguousOutcome = {
        errorCode: "partial_apply",
        errorMessage: "Transaction contains a previously failed task",
      };
      return;
    }

    const outcome = inspectTaskChainPostcondition_(
      tables[chain[0].sheetName],
      chain,
    );

    if (outcome.status === "applied") {
      appliedChains += 1;
      return;
    }

    if (outcome.status === "unapplied") {
      unappliedChains += 1;
      return;
    }

    ambiguousOutcome = outcome;
  });

  if (ambiguousOutcome !== null || (appliedChains > 0 && unappliedChains > 0)) {
    return {
      status: "failed",
      errorCode: ambiguousOutcome
        ? ambiguousOutcome.errorCode
        : "partial_apply",
      errorMessage: ambiguousOutcome
        ? ambiguousOutcome.errorMessage
        : "Only part of the transaction is visible in the canonical sheet",
    };
  }

  if (appliedChains === chains.length) {
    return { status: "done" };
  }

  if (unappliedChains === chains.length) {
    return { status: "pending" };
  }

  return {
    status: "failed",
    errorCode: "partial_apply",
    errorMessage: "Transaction postconditions are ambiguous",
  };
}

function readCanonicalTablesForTransaction_(spreadsheet, tasks, existingTables) {
  const tables = existingTables || Object.create(null);

  tasks.forEach(function(task) {
    if (!tables[task.sheetName]) {
      tables[task.sheetName] = readCanonicalTableForTask_(spreadsheet, task);
    }
  });

  return tables;
}

function groupTasksByTarget_(tasks) {
  const chainsByTarget = Object.create(null);
  const chains = [];

  tasks.forEach(function(task) {
    const target = [task.sheetName, task.keyHeader, task.keyValue].join(
      "\u001f",
    );

    if (!chainsByTarget[target]) {
      chainsByTarget[target] = [];
      chains.push(chainsByTarget[target]);
    }

    chainsByTarget[target].push(task);
  });

  chains.forEach(function(chain) {
    chain.sort(function(left, right) {
      return left.transactionIndex - right.transactionIndex
        || left.sequence - right.sequence;
    });
  });

  return chains;
}

function inspectTaskChainPostcondition_(table, chain) {
  const firstTask = chain[0];
  const lastTask = chain[chain.length - 1];

  if (table === undefined || firstTask === undefined || lastTask === undefined) {
    return {
      status: "ambiguous",
      errorCode: "partial_apply",
      errorMessage: "Missing canonical table for transaction recovery",
    };
  }

  // A final done status is already a durable outcome. This also handles a
  // redacted payload whose original immutable intent is no longer readable.
  if (lastTask.status === "done") {
    return { status: "applied" };
  }

  const initialState = inspectTaskInitialState_(table, chain);
  const finalState = inspectTaskFinalState_(table, chain, initialState);

  if (finalState.status === "ambiguous") {
    return finalState;
  }

  if (finalState.status === "applied" && initialState.status === "applied") {
    return {
      status: "ambiguous",
      errorCode: "partial_apply",
      errorMessage: "Initial and final states are indistinguishable",
    };
  }

  if (finalState.status === "applied") {
    return { status: "applied" };
  }

  if (initialState.status === "applied") {
    return { status: "unapplied" };
  }

  return {
    status: "ambiguous",
    errorCode: "partial_apply",
    errorMessage: "Transaction target is neither initial nor final state",
  };
}

function inspectTaskInitialState_(table, chain) {
  const firstTask = chain[0];
  const rowIndex = table.rowsByKey[firstTask.keyValue];

  if (chain.some(function(task) { return task.status === "done"; })) {
    return { status: "not_initial" };
  }

  if (firstTask.operation === "insert") {
    return rowIndex === undefined
      ? { status: "applied" }
      : { status: "not_initial" };
  }

  if (rowIndex === undefined) {
    return { status: "not_initial" };
  }

  if (firstTask.operation === "delete") {
    const payload = requireTaskPayloadObject_(firstTask);
    const rowToDelete = requirePayloadObject_(
      payload.rowToDelete,
      "payload.rowToDelete",
    );
    const expectedRow = rowObjectToCanonicalCells_(
      table,
      rowToDelete,
      null,
    );

    assertTaskRowMatchesKey_(table, expectedRow, firstTask);

    return areCanonicalRowsEqual_(table.rows[rowIndex], expectedRow)
      ? { status: "applied" }
      : { status: "not_initial" };
  }

  return Number(table.rows[rowIndex][table.versionIndex])
      === firstTask.expectedVersion
    ? { status: "applied" }
    : { status: "not_initial" };
}

function inspectTaskFinalState_(table, chain, initialState) {
  const lastTask = chain[chain.length - 1];
  const rowIndex = table.rowsByKey[lastTask.keyValue];

  if (lastTask.operation === "insert") {
    if (rowIndex === undefined) {
      return { status: "not_final" };
    }

    const payload = requireTaskPayloadObject_(lastTask);
    const rowObject = requirePayloadObject_(payload.row, "payload.row");
    const expectedRow = rowObjectToCanonicalCells_(table, rowObject, null);

    assertTaskRowMatchesKey_(table, expectedRow, lastTask);

    return areCanonicalRowsEqual_(table.rows[rowIndex], expectedRow)
      ? { status: "applied" }
      : {
          status: "ambiguous",
          errorCode: "partial_apply",
          errorMessage: "Final inserted row does not match the queued payload",
        };
  }

  if (lastTask.operation === "update") {
    if (rowIndex === undefined) {
      return {
        status: "ambiguous",
        errorCode: "partial_apply",
        errorMessage: "Final updated row is missing from the canonical sheet",
      };
    }

    const payload = requireTaskPayloadObject_(lastTask);
    const rowToWrite = requirePayloadObject_(
      payload.rowToWrite,
      "payload.rowToWrite",
    );
    const versionToWrite = requireTaskFiniteNumber_(
      rowToWrite._version,
      "payload.rowToWrite._version",
    );

    if (versionToWrite <= lastTask.expectedVersion) {
      throw gatewayError_(
        "invalid_task",
        "payload.rowToWrite._version must advance expectedVersion",
      );
    }

    const expectedRow = rowObjectToCanonicalCells_(
      table,
      rowToWrite,
      table.rows[rowIndex],
    );
    assertTaskRowMatchesKey_(table, expectedRow, lastTask);

    if (areCanonicalRowsEqual_(table.rows[rowIndex], expectedRow)) {
      return { status: "applied" };
    }

    if (Number(table.rows[rowIndex][table.versionIndex])
        === lastTask.expectedVersion) {
      return { status: "not_final" };
    }

    return {
      status: "ambiguous",
      errorCode: "partial_apply",
      errorMessage: "Final updated row does not match the queued payload",
    };
  }

  assertDeletePayloadMatchesTask_(lastTask);

  if (rowIndex === undefined) {
    return {
      status: "ambiguous",
      errorCode: "partial_apply",
      errorMessage: "Delete postcondition cannot be proven after the row disappeared",
    };
  }

  if (initialState.status === "applied") {
    return { status: "not_final" };
  }

  if (Number(table.rows[rowIndex][table.versionIndex])
      === lastTask.expectedVersion) {
    return { status: "not_final" };
  }

  return {
    status: "ambiguous",
    errorCode: "partial_apply",
    errorMessage: "Final delete target changed before recovery completed",
  };
}

function areCanonicalRowsEqual_(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (!areCanonicalCellsEqual_(left[index], right[index])) {
      return false;
    }
  }

  return true;
}

function areCanonicalCellsEqual_(left, right) {
  if (left === right) {
    return true;
  }

  if (
    (left === null || left === "")
    && (right === null || right === "")
  ) {
    return true;
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return String(left) === String(right);
}

function applyQueueTransaction_(spreadsheet, tasks) {
  const tables = Object.create(null);
  const affectedSheetNames = [];

  tasks.forEach(function(task) {
    if (!tables[task.sheetName]) {
      tables[task.sheetName] = readCanonicalTableForTask_(spreadsheet, task);
      affectedSheetNames.push(task.sheetName);
    }

    applyTaskToCanonicalTable_(tables[task.sheetName], task);
  });

  affectedSheetNames.sort().forEach(function(sheetName) {
    writeCanonicalTable_(tables[sheetName]);
  });
}

function readCanonicalTableForTask_(spreadsheet, task) {
  const mapping = getCanonicalSheetMapping_(spreadsheet, task.sheetName);

  if (!mapping) {
    throw gatewayError_(
      "invalid_task",
      "Missing canonical sheet mapping for " + task.sheetName,
    );
  }

  const sheet = getSheet_(spreadsheet, mapping.canonicalSheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    throw gatewayError_(
      "schema_drift",
      "Canonical sheet is empty for " + task.sheetName,
    );
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
  const keyIndex = headers.indexOf(task.keyHeader);
  const versionIndex = headers.indexOf("_version");

  if (keyIndex === -1) {
    throw gatewayError_("schema_drift", "Missing key header: " + task.keyHeader);
  }

  if (versionIndex === -1) {
    throw gatewayError_("schema_drift", "Missing version header: _version");
  }

  const rows = values.slice(1).map(function(row) {
    return row.map(toSheetCell_);
  });
  const rowsByKey = Object.create(null);

  rows.forEach(function(row, index) {
    const keyValue = String(row[keyIndex]);

    if (rowsByKey[keyValue] !== undefined) {
      throw gatewayError_("schema_drift", "Duplicate key \"" + keyValue + "\"");
    }

    rowsByKey[keyValue] = index;
  });

  return {
    sheet: sheet,
    headers: headers,
    keyIndex: keyIndex,
    versionIndex: versionIndex,
    rows: rows,
    rowsByKey: rowsByKey,
  };
}

function applyTaskToCanonicalTable_(table, task) {
  if (task.operation === "insert") {
    applyInsertTask_(table, task);
    return;
  }

  if (task.operation === "update") {
    applyUpdateTask_(table, task);
    return;
  }

  applyDeleteTask_(table, task);
}

function applyInsertTask_(table, task) {
  if (table.rowsByKey[task.keyValue] !== undefined) {
    throw gatewayError_("conflict", "Row \"" + task.keyValue + "\" already exists");
  }

  const payload = requireTaskPayloadObject_(task);
  const rowObject = requirePayloadObject_(payload.row, "payload.row");
  const row = rowObjectToCanonicalCells_(table, rowObject, null);

  assertTaskRowMatchesKey_(table, row, task);
  table.rowsByKey[task.keyValue] = table.rows.length;
  table.rows.push(row);
}

function applyUpdateTask_(table, task) {
  const rowIndex = table.rowsByKey[task.keyValue];

  if (rowIndex === undefined) {
    throw gatewayError_("conflict", "Row \"" + task.keyValue + "\" is missing");
  }

  assertCurrentVersion_(table, rowIndex, task);

  const payload = requireTaskPayloadObject_(task);
  const rowToWrite = requirePayloadObject_(
    payload.rowToWrite,
    "payload.rowToWrite",
  );
  const versionToWrite = requireTaskFiniteNumber_(
    rowToWrite._version,
    "payload.rowToWrite._version",
  );

  if (versionToWrite <= task.expectedVersion) {
    throw gatewayError_(
      "invalid_task",
      "payload.rowToWrite._version must advance expectedVersion",
    );
  }

  table.rows[rowIndex] = rowObjectToCanonicalCells_(
    table,
    rowToWrite,
    table.rows[rowIndex],
  );
  assertTaskRowMatchesKey_(table, table.rows[rowIndex], task);
}

function applyDeleteTask_(table, task) {
  const rowIndex = table.rowsByKey[task.keyValue];

  if (rowIndex === undefined) {
    throw gatewayError_("conflict", "Row \"" + task.keyValue + "\" is missing");
  }

  assertCurrentVersion_(table, rowIndex, task);
  assertDeletePayloadMatchesTask_(task);

  table.rows.splice(rowIndex, 1);
  table.rowsByKey = Object.create(null);
  table.rows.forEach(function(row, index) {
    table.rowsByKey[String(row[table.keyIndex])] = index;
  });
}

function assertDeletePayloadMatchesTask_(task) {
  const payload = requireTaskPayloadObject_(task);
  const rowToDelete = requirePayloadObject_(
    payload.rowToDelete,
    "payload.rowToDelete",
  );
  const versionToDelete = requireTaskFiniteNumber_(
    rowToDelete._version,
    "payload.rowToDelete._version",
  );

  if (String(rowToDelete[task.keyHeader]) !== task.keyValue) {
    throw gatewayError_(
      "invalid_task",
      "payload.rowToDelete key must match queued key",
    );
  }

  if (versionToDelete !== task.expectedVersion) {
    throw gatewayError_(
      "invalid_task",
      "payload.rowToDelete._version must match expectedVersion",
    );
  }
}

function assertCurrentVersion_(table, rowIndex, task) {
  const currentVersion = Number(table.rows[rowIndex][table.versionIndex]);

  if (currentVersion !== task.expectedVersion) {
    throw gatewayError_(
      "conflict",
      "Stale task for key \"" + task.keyValue + "\"",
    );
  }
}

function assertTaskRowMatchesKey_(table, row, task) {
  if (String(row[table.keyIndex]) !== task.keyValue) {
    throw gatewayError_(
      "invalid_task",
      "Task payload key does not match queued key for " + task.taskId,
    );
  }
}

function requireTaskPayloadObject_(task) {
  try {
    return requirePayloadObject_(
      JSON.parse(task.payloadJson),
      "payloadJson",
    );
  } catch (error) {
    if (error && error.code) {
      throw error;
    }

    throw gatewayError_("invalid_task", "Invalid payloadJson for " + task.taskId);
  }
}

function requirePayloadObject_(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError_("invalid_task", name + " must be an object");
  }

  return value;
}

function requireTaskFiniteNumber_(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw gatewayError_("invalid_task", name + " must be a number");
  }

  return value;
}

function rowObjectToCanonicalCells_(table, rowObject, existingRow) {
  return table.headers.map(function(header, index) {
    if (Object.prototype.hasOwnProperty.call(rowObject, header)) {
      return toSheetCell_(rowObject[header]);
    }

    return existingRow ? existingRow[index] : null;
  });
}

function writeCanonicalTable_(table) {
  table.sheet
    .getRange(1, 1, 1, table.headers.length)
    .setValues([table.headers]);

  if (table.rows.length > 0) {
    table.sheet
      .getRange(2, 1, table.rows.length, table.headers.length)
      .setValues(table.rows);
  }

  clearTrailingCanonicalRows_(table.sheet, table.rows.length + 2);
  clearTrailingCanonicalColumns_(table.sheet, table.headers.length + 1);
}

function clearTrailingCanonicalRows_(sheet, firstTrailingRow) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow >= firstTrailingRow && lastColumn > 0) {
    sheet
      .getRange(firstTrailingRow, 1, lastRow - firstTrailingRow + 1, lastColumn)
      .clearContent();
  }
}

function clearTrailingCanonicalColumns_(sheet, firstTrailingColumn) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastColumn >= firstTrailingColumn && lastRow > 0) {
    sheet
      .getRange(1, firstTrailingColumn, lastRow, lastColumn - firstTrailingColumn + 1)
      .clearContent();
  }
}

function markQueueTasks_(queueSheet, tasks, patch) {
  const statusIndex = TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("status") + 1;
  const payloadJsonIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("payloadJson") + 1;
  const attemptsIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("attempts") + 1;
  const lastErrorCodeIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("lastErrorCode") + 1;
  const lastErrorMessageIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("lastErrorMessage") + 1;
  const updatedAtIndex =
    TYPED_SHEETS_TASK_QUEUE_HEADERS.indexOf("updatedAt") + 1;

  tasks.forEach(function(task) {
    if (patch.status !== undefined) {
      queueSheet.getRange(task.rowNumber, statusIndex, 1, 1).setValues([
        [patch.status],
      ]);
    }

    if (patch.payloadJson !== undefined) {
      queueSheet.getRange(task.rowNumber, payloadJsonIndex, 1, 1).setValues([
        [patch.payloadJson],
      ]);
    }

    if (patch.status === "processing") {
      const nextAttempts = Number(task.attempts || 0) + 1;

      queueSheet.getRange(task.rowNumber, attemptsIndex, 1, 1).setValues([
        [nextAttempts],
      ]);
      task.attempts = nextAttempts;
    }

    if (patch.lastErrorCode !== undefined) {
      queueSheet.getRange(task.rowNumber, lastErrorCodeIndex, 1, 1).setValues([
        [patch.lastErrorCode],
      ]);
    }

    if (patch.lastErrorMessage !== undefined) {
      queueSheet
        .getRange(task.rowNumber, lastErrorMessageIndex, 1, 1)
        .setValues([[patch.lastErrorMessage]]);
    }

    if (patch.updatedAt !== undefined) {
      queueSheet.getRange(task.rowNumber, updatedAtIndex, 1, 1).setValues([
        [patch.updatedAt],
      ]);
    }
  });
}

function getOrCreateCanonicalSheetName_(spreadsheet, logicalSheetName) {
  const existingMapping = getCanonicalSheetMapping_(
    spreadsheet,
    logicalSheetName,
  );

  if (existingMapping) {
    return existingMapping.canonicalSheetName;
  }

  const hash = createShortHash_(logicalSheetName);
  let collisionIndex = 0;

  while (collisionIndex < 100) {
    const canonicalSheetName = createCanonicalSheetName_(
      logicalSheetName,
      hash,
      collisionIndex,
    );

    if (!spreadsheet.getSheetByName(canonicalSheetName)) {
      persistCanonicalSheetMapping_(spreadsheet, {
        logicalSheetName: logicalSheetName,
        canonicalSheetName: canonicalSheetName,
        projectionSheetName: logicalSheetName,
      });

      return canonicalSheetName;
    }

    collisionIndex += 1;
  }

  throw gatewayError_(
    "system_sheet_name_collision",
    "Could not allocate a canonical sheet name for " + logicalSheetName,
  );
}

function createCanonicalSheetName_(logicalSheetName, hash, collisionIndex) {
  const suffix = "_" + hash + (collisionIndex === 0 ? "" : "_" + collisionIndex);
  const maxSlugLength =
    TYPED_SHEETS_MAX_SHEET_NAME_LENGTH
    - TYPED_SHEETS_DATA_SHEET_PREFIX.length
    - suffix.length;
  const slug = createSheetNameSlug_(logicalSheetName).slice(
    0,
    Math.max(1, maxSlugLength),
  );

  return TYPED_SHEETS_DATA_SHEET_PREFIX + slug + suffix;
}

function createSheetNameSlug_(value) {
  const slug = value
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || "sheet";
}

function createShortHash_(value) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
  )).slice(0, 12);
}

/**
 * Creates a stable fingerprint for one enqueue request. Mutable queue state is
 * intentionally excluded so the fingerprint survives processing and retries.
 */
function createTaskFingerprint_(task) {
  const canonicalValue = [
    task.taskId,
    task.transactionId,
    task.transactionIndex,
    task.operation,
    task.sheetName,
    task.keyHeader,
    task.keyValue,
    task.expectedVersion === null ? "" : task.expectedVersion,
    task.payloadJson,
  ].join("\u001f");

  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonicalValue,
  ));
}

function bytesToHex_(bytes) {
  let hex = "";

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const unsignedByte = byte < 0 ? byte + 256 : byte;
    hex += ("0" + unsignedByte.toString(16)).slice(-2);
  }

  return hex;
}

function getCanonicalSheetMapping_(spreadsheet, logicalSheetName) {
  const sheet = spreadsheet.getSheetByName(TYPED_SHEETS_META_SHEET_NAME);

  if (!sheet) {
    return null;
  }

  const rows = readMetaRows_(sheet);
  const key = TYPED_SHEETS_META_MAPPING_KEY_PREFIX + logicalSheetName;

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] !== key) {
      continue;
    }

    try {
      const mapping = JSON.parse(String(rows[index][1]));

      if (
        mapping
        && mapping.logicalSheetName === logicalSheetName
        && typeof mapping.canonicalSheetName === "string"
        && mapping.canonicalSheetName.trim() !== ""
      ) {
        return mapping;
      }
    } catch (error) {
      throw gatewayError_(
        "invalid_meta",
        "Invalid canonical sheet mapping for " + logicalSheetName,
      );
    }
  }

  return null;
}

function persistCanonicalSheetMapping_(spreadsheet, mapping) {
  const sheet = ensureMetaSheetStructure_(spreadsheet);
  const rows = readMetaRows_(sheet);
  const key = TYPED_SHEETS_META_MAPPING_KEY_PREFIX + mapping.logicalSheetName;
  const value = JSON.stringify(mapping);

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] === key) {
      sheet.getRange(index + 2, 2, 1, 1).setValues([[value]]);
      return;
    }
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 2).setValues([[key, value]]);
}

function readMetaRows_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, 2).getValues().map(function(row) {
    return [String(row[0] || ""), String(row[1] || "")];
  });
}

function requireProjectionSheetName_(value, name) {
  const sheetName = requireString_(value, name);

  if (sheetName.indexOf(TYPED_SHEETS_INTERNAL_PREFIX) === 0) {
    throw gatewayError_(
      "invalid_request",
      name + " must not start with " + TYPED_SHEETS_INTERNAL_PREFIX,
    );
  }

  return sheetName;
}

function ensureProjectionSheet_(spreadsheet, sheetName, headers) {
  // Validate the requested schema even when the sheet is being created. This
  // catches duplicate headers before they become a new, invalid system sheet.
  assertExpectedHeaders_(headers, headers, "projection initialization");

  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    assertExpectedHeaders_(
      readHeaderRow_(sheet),
      headers,
      "projection initialization",
    );
  }
}

function ensureInternalSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    assertExpectedHeaders_(
      readHeaderRow_(sheet),
      headers,
      "canonical initialization",
    );
  }

  hideInternalSheet_(sheet);
  protectInternalSheet_(sheet, sheetName);
}

function hideInternalSheet_(sheet) {
  sheet.hideSheet();
}

function protectInternalSheet_(sheet, sheetName) {
  try {
    const protection = sheet.protect();
    protection.setDescription("typed-sheets internal sheet: " + sheetName);

    if (typeof protection.setWarningOnly === "function") {
      protection.setWarningOnly(false);
    }

    if (
      typeof protection.getEditors === "function"
      && typeof protection.removeEditors === "function"
    ) {
      protection.removeEditors(protection.getEditors());
    }

    if (
      typeof protection.canDomainEdit === "function"
      && protection.canDomainEdit()
      && typeof protection.setDomainEdit === "function"
    ) {
      protection.setDomainEdit(false);
    }
  } catch (error) {
    Logger.log(
      "typed-sheets could not protect internal sheet "
        + sheetName
        + ": "
        + (error && error.message ? error.message : String(error)),
    );
  }
}

function writeHeaderIfEmpty_(sheet, headers) {
  if (!isHeaderRowEmpty_(sheet)) {
    throw gatewayError_(
      "header_not_empty",
      "Header row is not empty; refusing to overwrite existing data",
    );
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function readSheet_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    return {
      ok: true,
      headers: [],
      rows: [],
    };
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headerValues = values[0] || [];
  const headers = headerValues.map(function(value) {
    return String(value);
  });

  if (isEmptyRow_(headerValues)) {
    return {
      ok: true,
      headers: [],
      rows: [],
    };
  }

  const rows = values.slice(1).map(function(cells, index) {
    return {
      rowNumber: index + 2,
      cells: cells.map(toSheetCell_),
    };
  });

  return {
    ok: true,
    headers: headers,
    rows: rows,
  };
}

/** Reads canonical rows by logical repository name for queued repositories. */
function readCanonicalSheet_(spreadsheet, request) {
  const logicalSheetName = requireProjectionSheetName_(
    request.sheetName,
    "sheetName",
  );
  const mapping = getCanonicalSheetMapping_(spreadsheet, logicalSheetName);

  if (!mapping) {
    throw gatewayError_(
      "schema_drift",
      "Missing canonical sheet mapping for " + logicalSheetName,
    );
  }

  return readSheet_(spreadsheet, {
    sheetName: mapping.canonicalSheetName,
  });
}

// Legacy direct-write gateway helpers. They are kept only for existing
// createRepositoryFromConfig() Apps Script users until queued repository writes
// replace this path.
function writeHeader_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const headers = requireStringArray_(request.headers, "headers");

  writeHeaderIfEmpty_(sheet, headers);
}

function appendRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const row = requireSheetCellArray_(request.row, "row");

  sheet.appendRow(row);
}

// Appends multiple rows with one range write to reduce gateway round trips.
function appendRows_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const rows = requireSheetCellRows_(request.rows, "rows");

  if (rows.length === 0) {
    return;
  }

  const width = rows[0].length;

  rows.forEach(function(row, index) {
    if (row.length !== width) {
      throw gatewayError_(
        "invalid_request",
        "rows[" + index + "] must have the same length as rows[0]",
      );
    }
  });

  sheet
    .getRange(sheet.getLastRow() + 1, 1, rows.length, width)
    .setValues(rows);
}

function updateRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const row = requireSheetCellArray_(request.row, "row");
  const rowNumber = requirePositiveInteger_(request.rowNumber, "rowNumber");

  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
}

// Updates rows by key after validating expected headers and _version under one lock.
function updateRowsByKey_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const expectedHeaders = requireStringArray_(
    request.expectedHeaders,
    "expectedHeaders",
  );
  const keyHeader = requireString_(request.keyHeader, "keyHeader");
  const versionHeader = requireString_(request.versionHeader, "versionHeader");
  const updates = requireUpdateRows_(request.updates, "updates");
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    throw gatewayError_("schema_drift", "Sheet is empty before update");
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
  const keyIndex = headers.indexOf(keyHeader);
  const versionIndex = headers.indexOf(versionHeader);

  assertExpectedHeaders_(headers, expectedHeaders, "update");

  if (keyIndex === -1) {
    throw gatewayError_("schema_drift", "Missing key header: " + keyHeader);
  }

  if (versionIndex === -1) {
    throw gatewayError_(
      "schema_drift",
      "Missing version header: " + versionHeader,
    );
  }

  const updatesById = Object.create(null);
  const seenRequestedIds = Object.create(null);
  const rowsToUpdate = [];

  updates.forEach(function(update) {
    if (updatesById[update.id]) {
      throw gatewayError_(
        "invalid_request",
        "updates must not contain duplicate ids",
      );
    }

    if (update.row.length !== expectedHeaders.length) {
      throw gatewayError_(
        "invalid_request",
        "updates." + update.id + ".row must match expectedHeaders length",
      );
    }

    updatesById[update.id] = update;
  });

  values.slice(1).forEach(function(cells, index) {
    const id = String(cells[keyIndex]);

    if (!updatesById[id] && !seenRequestedIds[id]) {
      return;
    }

    if (seenRequestedIds[id]) {
      throw gatewayError_("schema_drift", "Duplicate key \"" + id + "\"");
    }

    seenRequestedIds[id] = true;

    const update = updatesById[id];
    const version = Number(cells[versionIndex]);

    if (version !== update.expectedVersion) {
      throw gatewayError_("conflict", "Stale write for key \"" + id + "\"");
    }

    rowsToUpdate.push({
      id: id,
      rowNumber: index + 2,
      row: update.row,
    });

    delete updatesById[id];
  });

  Object.keys(updatesById).forEach(function(id) {
    throw gatewayError_("conflict", "Row \"" + id + "\" changed before update");
  });

  rowsToUpdate.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, update.row.length).setValues([
      update.row,
    ]);
  });

  return {
    ok: true,
    updatedRows: rowsToUpdate.map(function(update) {
      return {
        id: update.id,
        cells: update.row.map(toSheetCell_),
      };
    }),
  };
}

// Deletes only data rows; row 1 is reserved for the schema header.
function deleteRow_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const rowNumber = requirePositiveInteger_(request.rowNumber, "rowNumber");

  if (rowNumber < 2) {
    throw gatewayError_("invalid_request", "rowNumber must target a data row");
  }

  sheet.deleteRow(rowNumber);
}

// Deletes multiple data rows from bottom to top so row shifts are safe.
function deleteRows_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const rowNumbers = requirePositiveIntegerArray_(
    request.rowNumbers,
    "rowNumbers",
  );
  const seen = {};

  rowNumbers.forEach(function(rowNumber) {
    if (rowNumber < 2) {
      throw gatewayError_("invalid_request", "rowNumbers must target data rows");
    }

    if (seen[rowNumber]) {
      throw gatewayError_(
        "invalid_request",
        "rowNumbers must not contain duplicates",
      );
    }

    seen[rowNumber] = true;
  });

  rowNumbers
    .slice()
    .sort(function(left, right) {
      return right - left;
    })
    .forEach(function(rowNumber) {
      sheet.deleteRow(rowNumber);
    });
}

// Deletes rows by key after validating the expected _version under one lock.
function deleteRowsByKey_(spreadsheet, request) {
  const sheet = getSheet_(spreadsheet, request.sheetName);
  const expectedHeaders = requireStringArray_(
    request.expectedHeaders,
    "expectedHeaders",
  );
  const keyHeader = requireString_(request.keyHeader, "keyHeader");
  const versionHeader = requireString_(request.versionHeader, "versionHeader");
  const ids = requireStringArray_(request.ids, "ids");
  const versionsById = requireNumberRecord_(request.versionsById, "versionsById");
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0 || lastColumn === 0) {
    throw gatewayError_("schema_drift", "Sheet is empty before delete");
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = (values[0] || []).map(function(value) {
    return String(value);
  });
  const keyIndex = headers.indexOf(keyHeader);
  const versionIndex = headers.indexOf(versionHeader);

  assertExpectedHeaders_(headers, expectedHeaders, "delete");

  if (keyIndex === -1) {
    throw gatewayError_("schema_drift", "Missing key header: " + keyHeader);
  }

  if (versionIndex === -1) {
    throw gatewayError_(
      "schema_drift",
      "Missing version header: " + versionHeader,
    );
  }

  const requestedIds = Object.create(null);
  const seenRequestedIds = Object.create(null);
  const rowsToDelete = [];

  ids.forEach(function(id) {
    if (requestedIds[id]) {
      throw gatewayError_("invalid_request", "ids must not contain duplicates");
    }

    requestedIds[id] = true;
  });

  values.slice(1).forEach(function(cells, index) {
    const id = String(cells[keyIndex]);

    if (!requestedIds[id] && !seenRequestedIds[id]) {
      return;
    }

    if (seenRequestedIds[id]) {
      throw gatewayError_("schema_drift", "Duplicate key \"" + id + "\"");
    }

    seenRequestedIds[id] = true;

    const version = Number(cells[versionIndex]);

    if (version !== versionsById[id]) {
      throw gatewayError_("conflict", "Stale delete for key \"" + id + "\"");
    }

    rowsToDelete.push({
      id: id,
      rowNumber: index + 2,
      cells: cells.map(toSheetCell_),
    });

    delete requestedIds[id];
  });

  Object.keys(requestedIds).forEach(function(id) {
    throw gatewayError_("conflict", "Row \"" + id + "\" changed before delete");
  });

  rowsToDelete
    .slice()
    .sort(function(left, right) {
      return right.rowNumber - left.rowNumber;
    })
    .forEach(function(row) {
      sheet.deleteRow(row.rowNumber);
    });

  return {
    ok: true,
    deletedRows: rowsToDelete.map(function(row) {
      return {
        id: row.id,
        cells: row.cells,
      };
    }),
  };
}

function getSheet_(spreadsheet, sheetName) {
  const name = requireString_(sheetName, "sheetName");
  const sheet = spreadsheet.getSheetByName(name);

  if (!sheet) {
    throw gatewayError_("sheet_not_found", "Sheet not found: " + name);
  }

  return sheet;
}

function requireString_(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw gatewayError_("invalid_request", name + " must be a non-empty string");
  }

  return value;
}

function requireStringArray_(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw gatewayError_(
      "invalid_request",
      name + " must be a non-empty string array",
    );
  }

  value.forEach(function(item, index) {
    if (typeof item !== "string" || item.trim() === "") {
      throw gatewayError_(
        "invalid_request",
        name + "[" + index + "] must be a non-empty string",
      );
    }
  });

  return value;
}

function requireSheetCellArray_(value, name) {
  if (!Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an array");
  }

  value.forEach(function(item, index) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw gatewayError_(
        "invalid_request",
        name + "[" + index + "] must be a string, number, boolean, or null",
      );
    }
  });

  return value;
}

function requireSheetCellRows_(value, name) {
  if (!Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an array");
  }

  value.forEach(function(row, index) {
    requireSheetCellArray_(row, name + "[" + index + "]");
  });

  return value;
}

function requireUpdateRows_(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw gatewayError_("invalid_request", name + " must be a non-empty array");
  }

  value.forEach(function(update, index) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw gatewayError_(
        "invalid_request",
        name + "[" + index + "] must be an object",
      );
    }

    requireString_(update.id, name + "[" + index + "].id");
    requireFiniteNumber_(
      update.expectedVersion,
      name + "[" + index + "].expectedVersion",
    );
    requireSheetCellArray_(update.row, name + "[" + index + "].row");
  });

  return value;
}

function requireQueueTasks_(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw gatewayError_("invalid_request", name + " must be a non-empty array");
  }

  return value.map(function(task, index) {
    const taskName = name + "[" + index + "]";

    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw gatewayError_("invalid_request", taskName + " must be an object");
    }

    const operation = requireQueueOperation_(
      task.operation,
      taskName + ".operation",
    );

    return {
      taskId: requireString_(task.taskId, taskName + ".taskId"),
      transactionId: requireString_(
        task.transactionId,
        taskName + ".transactionId",
      ),
      transactionIndex: requireNonNegativeInteger_(
        task.transactionIndex,
        taskName + ".transactionIndex",
      ),
      operation: operation,
      sheetName: requireProjectionSheetName_(
        task.sheetName,
        taskName + ".sheetName",
      ),
      keyHeader: requireString_(task.keyHeader, taskName + ".keyHeader"),
      keyValue: requireString_(task.keyValue, taskName + ".keyValue"),
      expectedVersion: requireQueueExpectedVersion_(
        task.expectedVersion,
        operation,
        taskName + ".expectedVersion",
      ),
      payloadJson: requireJsonObjectString_(
        task.payloadJson,
        taskName + ".payloadJson",
      ),
    };
  });
}

function requireProcessTaskQueueOptions_(request) {
  const maxTransactions = request.maxTransactions === undefined
    ? 1
    : requirePositiveInteger_(request.maxTransactions, "maxTransactions");

  return {
    maxTransactions: maxTransactions,
  };
}

function requireQueueOperation_(value, name) {
  const operation = requireString_(value, name);

  if (["insert", "update", "delete"].indexOf(operation) === -1) {
    throw gatewayError_(
      "invalid_request",
      name + " must be insert, update, or delete",
    );
  }

  return operation;
}

function requireQueueExpectedVersion_(value, operation, name) {
  if (operation === "insert") {
    if (value === null || value === "" || value === undefined) {
      return null;
    }

    throw gatewayError_(
      "invalid_request",
      name + " must be null or blank for insert tasks",
    );
  }

  return requireFiniteNumber_(value, name);
}

function requireJsonObjectString_(value, name) {
  const json = requireString_(value, name);
  let parsed;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw gatewayError_("invalid_request", name + " must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw gatewayError_("invalid_request", name + " must encode an object");
  }

  return json;
}

function requirePositiveInteger_(value, name) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw gatewayError_("invalid_request", name + " must be a positive integer");
  }

  return numberValue;
}

function requireNonNegativeInteger_(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw gatewayError_(
      "invalid_request",
      name + " must be a non-negative integer",
    );
  }

  return value;
}

function requirePositiveIntegerArray_(value, name) {
  if (!Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an array");
  }

  value.forEach(function(item, index) {
    requirePositiveInteger_(item, name + "[" + index + "]");
  });

  return value.map(function(item) {
    return Number(item);
  });
}

function requireFiniteNumber_(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw gatewayError_("invalid_request", name + " must be a number");
  }

  return value;
}

function requireNumberRecord_(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError_("invalid_request", name + " must be an object");
  }

  Object.keys(value).forEach(function(key) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw gatewayError_("invalid_request", name + "." + key + " must be a number");
    }
  });

  return value;
}

function assertExpectedHeaders_(actualHeaders, expectedHeaders, operation) {
  if (actualHeaders.length < expectedHeaders.length) {
    throw gatewayError_(
      "schema_drift",
      "Header row changed before " + operation,
    );
  }

  const seenHeaders = Object.create(null);

  actualHeaders.forEach(function(header) {
    if (header === "") {
      return;
    }

    if (seenHeaders[header]) {
      throw gatewayError_(
        "schema_drift",
        "Duplicate header before " + operation + ": " + header,
      );
    }

    seenHeaders[header] = true;
  });

  expectedHeaders.forEach(function(expectedHeader, index) {
    if (actualHeaders[index] !== expectedHeader) {
      throw gatewayError_(
        "schema_drift",
        "Header row changed before " + operation,
      );
    }
  });
}

function readHeaderRow_(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    return [];
  }

  return sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(function(value) {
      return String(value);
    });
}

function isHeaderRowEmpty_(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    return true;
  }

  const headerValues = sheet.getRange(1, 1, 1, lastColumn).getValues()[0] || [];

  return isEmptyRow_(headerValues);
}

function isEmptyRow_(row) {
  return row.every(function(value) {
    return value === "" || value === null;
  });
}

function toSheetCell_(value) {
  if (value === "") {
    return null;
  }

  return value;
}

function gatewayError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function error_(code, message) {
  return json_({
    ok: false,
    code: code,
    error: code,
    message: message,
  });
}

function createTypedSheetsConfig_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = spreadsheet.getActiveSheet();
  const lock = LockService.getDocumentLock();

  lock.waitLock(30000);

  try {
    const existing = getTypedSheetsConfig_();
    const gatewayUrl = getGatewayUrl_(existing);
    const gatewaySecret = existing && existing.auth.gatewaySecret
      ? existing.auth.gatewaySecret
      : Utilities.getUuid();

    const config = {
      spreadsheetUrl: spreadsheet.getUrl(),
      defaultSheetName: activeSheet.getName(),
      auth: {
        type: "apps-script-gateway",
        gatewayUrl: gatewayUrl,
        gatewaySecret: gatewaySecret,
      },
    };

    PropertiesService.getDocumentProperties().setProperty(
      TYPED_SHEETS_CONFIG_PROPERTY,
      JSON.stringify(config),
    );

    ensureMetaSheet_(spreadsheet, config);

    return config;
  } finally {
    lock.releaseLock();
  }
}

function getTypedSheetsConfig_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(
    TYPED_SHEETS_CONFIG_PROPERTY,
  );

  return raw ? JSON.parse(raw) : null;
}

function ensureMetaSheet_(spreadsheet, config) {
  const sheet = ensureMetaSheetStructure_(spreadsheet);
  const preservedRows = readMetaRows_(sheet).filter(function(row) {
    return row[0].indexOf(TYPED_SHEETS_META_MAPPING_KEY_PREFIX) === 0;
  });
  const rows = [
    ["spreadsheetUrl", config.spreadsheetUrl],
    ["defaultSheetName", config.defaultSheetName],
    ["gatewayUrl", config.auth.gatewayUrl],
    ["authType", config.auth.type],
    ["connectedAt", new Date().toISOString()],
  ].concat(preservedRows);

  sheet.clear();
  sheet.hideSheet();
  sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function ensureMetaSheetStructure_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(TYPED_SHEETS_META_SHEET_NAME)
    || spreadsheet.insertSheet(TYPED_SHEETS_META_SHEET_NAME);

  sheet.hideSheet();

  if (isHeaderRowEmpty_(sheet)) {
    sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  }

  return sheet;
}

function getGatewayUrl_(existingConfig) {
  if (TYPED_SHEETS_GATEWAY_URL.trim() !== "") {
    return requireGatewayUrl_(TYPED_SHEETS_GATEWAY_URL.trim());
  }

  if (
    existingConfig
    && existingConfig.auth
    && typeof existingConfig.auth.gatewayUrl === "string"
    && existingConfig.auth.gatewayUrl.trim() !== ""
  ) {
    return requireGatewayUrl_(existingConfig.auth.gatewayUrl.trim());
  }

  throw gatewayError_(
    "missing_gateway_url",
    "Set TYPED_SHEETS_GATEWAY_URL to the deployed Web App URL that ends with /exec before running setupTypedSheets()",
  );
}

function requireGatewayUrl_(gatewayUrl) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gatewayUrl)) {
    throw gatewayError_(
      "invalid_gateway_url",
      "TYPED_SHEETS_GATEWAY_URL must be a deployed Apps Script Web App URL that ends with /exec",
    );
  }

  return gatewayUrl;
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
