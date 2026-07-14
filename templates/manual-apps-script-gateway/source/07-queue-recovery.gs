// Source module for the generated manual Apps Script gateway.

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
      if (hasReachedQueueAttemptLimit_(group.tasks)) {
        markQueueTasks_(queueSheet, group.tasks, {
          status: "failed",
          lastErrorCode: "retry_limit_exceeded",
          lastErrorMessage:
            "Transaction exceeded the maximum queue processing attempts",
          updatedAt: recoveredAt,
        });

        group.tasks.forEach(function(task) {
          task.status = "failed";
          task.updatedAt = recoveredAt;
        });
        result.failedTransactions += 1;
        result.failedTasks += group.tasks.length;
        result.recoveredTransactions += 1;
        continue;
      }

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
    } else {
      assertCanonicalTaskMatchesTable_(tables[task.sheetName], task);
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
    if (isCanonicalIntermediateChainState_(table, chain)) {
      return {
        status: "ambiguous",
        errorCode: "partial_apply",
        errorMessage: "An intermediate state of the transaction is visible",
      };
    }

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
    requireInsertTaskRow_(table, firstTask);

    return rowIndex === undefined
      ? { status: "applied" }
      : { status: "not_initial" };
  }

  if (rowIndex === undefined) {
    return { status: "not_initial" };
  }

  if (firstTask.operation === "delete") {
    const rowToDelete = assertDeletePayloadMatchesTask_(firstTask);

    return areCanonicalPayloadFieldsEqual_(
      table,
      table.rows[rowIndex],
      rowToDelete,
    )
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
    const expectedRow = requireInsertTaskRow_(table, lastTask);

    if (initialState.status === "applied") {
      return { status: "not_final" };
    }

    if (rowIndex === undefined) {
      return { status: "not_final" };
    }

    return areCanonicalRowsEqual_(table.rows[rowIndex], expectedRow)
      ? { status: "applied" }
      : {
          status: "ambiguous",
          errorCode: "partial_apply",
          errorMessage: "Final inserted row does not match the queued payload",
        };
  }

  if (lastTask.operation === "update") {
    if (initialState.status === "applied") {
      return { status: "not_final" };
    }

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

  if (
    initialState.status === "applied"
    && chain[0].operation === "insert"
    && rowIndex === undefined
  ) {
    return {
      status: "ambiguous",
      errorCode: "partial_apply",
      errorMessage: "Initial and final delete states are indistinguishable",
    };
  }

  if (initialState.status === "applied") {
    return { status: "not_final" };
  }

  if (rowIndex === undefined) {
    return {
      status: "ambiguous",
      errorCode: "partial_apply",
      errorMessage: "Delete postcondition cannot be proven after the row disappeared",
    };
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

function isCanonicalIntermediateChainState_(table, chain) {
  if (chain.length < 2) {
    return false;
  }

  const lastTaskIndex = chain.length - 1;
  const lastTask = chain[lastTaskIndex];
  const rowIndex = table.rowsByKey[lastTask.keyValue];

  for (let index = 0; index < lastTaskIndex; index += 1) {
    const task = chain[index];

    if (task.operation === "delete") {
      if (rowIndex === undefined) {
        return true;
      }

      continue;
    }

    if (rowIndex === undefined) {
      continue;
    }

    let expectedRow;

    if (task.operation === "insert") {
      expectedRow = requireInsertTaskRow_(table, task);
    } else {
      const payload = requireTaskPayloadObject_(task);
      const rowObject = requirePayloadObject_(
        payload.rowToWrite,
        "payload.rowToWrite",
      );
      expectedRow = rowObjectToCanonicalCells_(
        table,
        rowObject,
        table.rows[rowIndex],
      );
    }

    assertTaskRowMatchesKey_(table, expectedRow, task);

    if (areCanonicalRowsEqual_(table.rows[rowIndex], expectedRow)) {
      return true;
    }
  }

  return false;
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

/**
 * Compares only the fields carried by a queued row payload. Canonical sheets
 * may contain additional unmodeled columns, which must not change recovery's
 * decision about a delete task.
 */
function areCanonicalPayloadFieldsEqual_(table, canonicalRow, rowObject) {
  return Object.keys(rowObject).every(function(header) {
    const index = table.headers.indexOf(header);

    if (index === -1) {
      throw gatewayError_(
        "schema_drift",
        "Missing canonical header for queued field: " + header,
      );
    }

    return areCanonicalCellsEqual_(
      canonicalRow[index],
      toSheetCell_(rowObject[header]),
    );
  });
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
