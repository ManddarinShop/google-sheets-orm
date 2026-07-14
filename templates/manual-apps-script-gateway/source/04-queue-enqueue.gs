// Source module for the generated manual Apps Script gateway.

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

    const existingTransactionTasks =
      queueState.tasksByTransactionId[taskWithFingerprint.transactionId] || [];

    if (
      existingTransactionTasks.some(function(existingTransactionTask) {
        return isTerminalQueueTask_(existingTransactionTask);
      })
    ) {
      throw gatewayError_(
        "duplicate_transaction",
        "Transaction already contains terminal tasks: "
          + taskWithFingerprint.transactionId,
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
