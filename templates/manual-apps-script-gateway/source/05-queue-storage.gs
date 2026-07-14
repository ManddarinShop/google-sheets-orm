// Source module for the generated manual Apps Script gateway.

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
    tasksByTransactionId: Object.create(null),
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
      if (!state.tasksByTransactionId[task.transactionId]) {
        state.tasksByTransactionId[task.transactionId] = [];
      }
      state.tasksByTransactionId[task.transactionId].push(task);
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

function isTerminalQueueTask_(task) {
  return task.status === "done" || task.status === "failed";
}

/**
 * Processes pending queue transaction groups into canonical sheets.
 *
 * This processor keeps the document lock for the full claim, apply, and status
 * update cycle. It applies complete pending groups in sequence order, rewrites
 * affected canonical sheets in bulk, and recovers processing claims whose
 * lease expired after an interrupted execution.
 */

function isStaleProcessingTask_(task, nowMs) {
  if (task.status !== "processing") {
    return false;
  }

  const updatedAtMs = Date.parse(task.updatedAt);

  return !Number.isFinite(updatedAtMs)
    || nowMs - updatedAtMs >= TYPED_SHEETS_PROCESSING_LEASE_MS;
}

function hasReachedQueueAttemptLimit_(tasks) {
  return tasks.some(function(task) {
    return task.attempts >= TYPED_SHEETS_MAX_QUEUE_ATTEMPTS;
  });
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
    attempts: parseQueuedTaskAttempts_(row[11], rowNumber),
    lastErrorCode: String(row[12] || ""),
    lastErrorMessage: String(row[13] || ""),
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

/**
 * Parses the retry counter stored in the queue sheet. Invalid counters must
 * fail at the queue boundary so they cannot bypass the retry limit or keep a
 * transaction stuck in recovery indefinitely.
 */
function parseQueuedTaskAttempts_(value, rowNumber) {
  if (value === "" || value === null || value === undefined) {
    return 0;
  }

  const attempts = value;

  if (
    typeof attempts !== "number"
    || !Number.isInteger(attempts)
    || attempts < 0
  ) {
    throw gatewayError_(
      "invalid_task",
      "Invalid attempts at queue row " + rowNumber,
    );
  }

  return attempts;
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

  if (patch.status !== undefined) {
    writeQueueColumnValues_(queueSheet, tasks, statusIndex, patch.status);
  }

  if (patch.payloadJson !== undefined) {
    writeQueueColumnValues_(
      queueSheet,
      tasks,
      payloadJsonIndex,
      patch.payloadJson,
    );
  }

  if (patch.status === "processing") {
    const nextAttempts = tasks.map(function(task) {
      return Number(task.attempts || 0) + 1;
    });

    writeQueueColumnValues_(queueSheet, tasks, attemptsIndex, nextAttempts);
    tasks.forEach(function(task, index) {
      task.attempts = nextAttempts[index];
    });
  }

  if (patch.lastErrorCode !== undefined) {
    writeQueueColumnValues_(
      queueSheet,
      tasks,
      lastErrorCodeIndex,
      patch.lastErrorCode,
    );
  }

  if (patch.lastErrorMessage !== undefined) {
    writeQueueColumnValues_(
      queueSheet,
      tasks,
      lastErrorMessageIndex,
      patch.lastErrorMessage,
    );
  }

  if (patch.updatedAt !== undefined) {
    writeQueueColumnValues_(
      queueSheet,
      tasks,
      updatedAtIndex,
      patch.updatedAt,
    );
  }
}

/** Writes one queue column in contiguous row ranges to minimize Sheets calls. */
function writeQueueColumnValues_(queueSheet, tasks, columnIndex, values) {
  if (tasks.length === 0) {
    return;
  }

  const entries = tasks.map(function(task, index) {
    return {
      rowNumber: task.rowNumber,
      value: Array.isArray(values) ? values[index] : values,
    };
  }).sort(function(left, right) {
    return left.rowNumber - right.rowNumber;
  });

  let rangeStart = 0;

  while (rangeStart < entries.length) {
    let rangeEnd = rangeStart + 1;

    while (
      rangeEnd < entries.length
      && entries[rangeEnd].rowNumber === entries[rangeEnd - 1].rowNumber + 1
    ) {
      rangeEnd += 1;
    }

    queueSheet
      .getRange(
        entries[rangeStart].rowNumber,
        columnIndex,
        rangeEnd - rangeStart,
        1,
      )
      .setValues(entries.slice(rangeStart, rangeEnd).map(function(entry) {
        return [entry.value];
      }));

    rangeStart = rangeEnd;
  }
}


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
