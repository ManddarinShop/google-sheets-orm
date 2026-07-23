// Source module for the generated manual Apps Script gateway.

function processTaskQueue_(spreadsheet, request) {
  const options = requireProcessTaskQueueOptions_(request);
  const queueSheet = ensureTaskQueueSheet_(spreadsheet);
  const queuedTasks = readQueuedTasks_(queueSheet);
  retryCompletedTaskRedactions_(queueSheet, queuedTasks);
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

  for (let groupIndex = 0; groupIndex < pendingGroups.length; groupIndex += 1) {
    const group = pendingGroups[groupIndex];

    if (hasReachedQueueAttemptLimit_(group.tasks)) {
      const updates = {
        status: "failed",
        lastErrorCode: "retry_limit_exceeded",
        lastErrorMessage:
          "Transaction exceeded the maximum queue processing attempts",
        updatedAt: new Date().toISOString(),
      };
      markQueueTasks_(queueSheet, group.tasks, updates);
      updateQueueTasksInMemory_(queuedTasks, group.tasks, updates);
      result.failedTransactions += 1;
      result.failedTasks += group.tasks.length;
      continue;
    }

    const processingUpdates = {
      status: "processing",
      updatedAt: processingStartedAt,
    };
    markQueueTasks_(queueSheet, group.tasks, processingUpdates);
    updateQueueTasksInMemory_(queuedTasks, group.tasks, processingUpdates);

    try {
      applyQueueTransaction_(spreadsheet, group.tasks);
    } catch (error) {
      const code = error && error.code ? error.code : "internal_error";
      const message = error && error.message ? error.message : String(error);

      if (error && error.canonicalWriteStarted === true) {
        recordCanonicalWriteFailure_(queueSheet, group.tasks, error);
        // The canonical outcome is unknown. Later transactions must remain
        // pending until this transaction is reconciled in sequence order.
        break;
      }

      const failedUpdates = {
        status: "failed",
        lastErrorCode: code,
        lastErrorMessage: message,
        updatedAt: new Date().toISOString(),
      };
      markQueueTasks_(queueSheet, group.tasks, failedUpdates);
      updateQueueTasksInMemory_(queuedTasks, group.tasks, failedUpdates);

      result.failedTransactions += 1;
      result.failedTasks += group.tasks.length;
      continue;
    }

    try {
      // Keep the claim in processing if this status write is interrupted.
      // The canonical write already happened, so the next processor run must
      // reconcile the postcondition instead of treating it as a normal apply
      // failure and permanently dead-lettering the transaction.
      const doneUpdates = {
        status: "done",
        payloadJson: JSON.stringify({ redacted: true }),
        lastErrorCode: "",
        lastErrorMessage: "",
        updatedAt: new Date().toISOString(),
      };
      markQueueTasks_(queueSheet, group.tasks, doneUpdates);
      updateQueueTasksInMemory_(queuedTasks, group.tasks, doneUpdates);
    } catch (error) {
      recordQueueCompletionFailure_(queueSheet, group.tasks, error);
      // Canonical data is already written but the terminal queue state is
      // unknown. Do not let a later transaction overtake this claim.
      break;
    }

    result.processedTransactions += 1;
    result.processedTasks += group.tasks.length;
  }

  // The document lock prevents another enqueue/process request from changing
  // the queue while this invocation is running. Keep the in-memory task state
  // updated as status writes succeed instead of scanning the append-only queue
  // a second time just to build the response summary.
  result.remainingPendingTasks = queuedTasks.filter(function(task) {
    return task.status === "pending";
  }).length;
  const recoveryPendingTasks = queuedTasks.filter(function(task) {
    return task.status === "processing"
      || (
        task.status === "done"
        && !isRedactedTaskPayload_(task.payloadJson)
      );
  }).length;

  // Omit the field for an empty recovery state so older callers that consume
  // this gateway response remain compatible. When present, the field includes
  // processing claims and completed tasks whose payload redaction needs retry.
  if (recoveryPendingTasks > 0) {
    result.recoveryPendingTasks = recoveryPendingTasks;
  }

  return result;
}

function updateQueueTasksInMemory_(allTasks, updatedTasks, updates) {
  const updatedTaskIds = Object.create(null);

  updatedTasks.forEach(function(task) {
    updatedTaskIds[task.taskId] = true;
  });

  allTasks.forEach(function(task) {
    if (!updatedTaskIds[task.taskId]) {
      return;
    }

    Object.keys(updates).forEach(function(field) {
      task[field] = updates[field];
    });
  });
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

function recordCanonicalWriteFailure_(queueSheet, tasks, error) {
  const message = error && error.message ? error.message : String(error);

  try {
    // At least one canonical write was attempted. Keep the transaction in
    // processing so the next lease expiry can inspect every affected sheet
    // and distinguish unapplied work from a partial canonical apply.
    markQueueTasks_(queueSheet, tasks, {
      lastErrorCode: "canonical_write_unconfirmed",
      lastErrorMessage:
        "Canonical write outcome is unconfirmed; recovery is required: "
        + message,
      updatedAt: new Date().toISOString(),
    });
  } catch (diagnosticError) {
    // If the queue diagnostic also fails, the original processing claim and
    // timestamp remain available for lease-based recovery.
  }
}

function retryCompletedTaskRedactions_(queueSheet, tasks) {
  const redactedPayload = JSON.stringify({ redacted: true });

  tasks.forEach(function(task) {
    if (task.status !== "done" || isRedactedTaskPayload_(task.payloadJson)) {
      return;
    }

    try {
      // Status and canonical data may already be durable even when the
      // original completion call lost its payload redaction write. Retry the
      // sensitive-data cleanup on every later processor invocation.
      markQueueTasks_(queueSheet, [task], {
        payloadJson: redactedPayload,
        lastErrorCode: "",
        lastErrorMessage: "",
        updatedAt: new Date().toISOString(),
      });
      task.payloadJson = redactedPayload;
      task.lastErrorCode = "";
      task.lastErrorMessage = "";
    } catch (error) {
      try {
        markQueueTasks_(queueSheet, [task], {
          lastErrorCode: "redaction_unconfirmed",
          lastErrorMessage:
            "Completed task payload redaction failed: "
            + (error && error.message ? error.message : String(error)),
          updatedAt: new Date().toISOString(),
        });
      } catch (diagnosticError) {
        // Preserve the completed task and retry the cleanup on the next run.
      }
    }
  });
}

/**
 * Reconciles expired processing claims at transaction granularity. A complete
 * postcondition match is marked done, an unapplied group is returned to
 * pending, and an ambiguous or partial result is failed conservatively.
 */
