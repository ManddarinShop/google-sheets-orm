// Source module for the generated manual Apps Script gateway.

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
