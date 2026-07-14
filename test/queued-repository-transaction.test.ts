import { describe, expect, it } from "vitest";

import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
  EnqueueTasksResult,
  InitializeSystemSheetsResult,
  ProcessTaskQueueInput,
  ProcessTaskQueueResult,
  SheetSnapshot,
} from "../src/adapter/Adapter.js";
import { number, text } from "../src/core/schema/index.js";
import {
  createQueuedRepositoryQueueProcessor,
  createQueuedSheetRepository,
  summarizeProcessTaskQueueResult,
} from "../src/core/repository/index.js";

interface Order {
  id: string;
  userId: string;
  status: string;
  canceledAt: string | undefined;
  _version: number;
}

class FakeQueueAdapter implements AppsScriptQueueAdapter {
  readonly enqueuedTasks: EnqueueTasksInput[] = [];
  readonly readSheets: string[] = [];
  readonly initializedSystemSheets: Array<{
    sheetName: string;
    headers: string[];
  }> = [];
  readonly processedTaskQueues: Array<ProcessTaskQueueInput> = [];
  enqueueError: Error | null = null;
  enqueueErrorAfterRecord: Error | null = null;
  processResult: ProcessTaskQueueResult = {
    processedTransactions: 1,
    failedTransactions: 0,
    processedTasks: 1,
    failedTasks: 0,
    remainingPendingTasks: 0,
  };
  private canonicalSnapshot: SheetSnapshot | null = null;

  constructor(private snapshot: SheetSnapshot) {}

  setSnapshot(snapshot: SheetSnapshot): void {
    this.snapshot = snapshot;
  }

  setCanonicalSnapshot(snapshot: SheetSnapshot): void {
    this.canonicalSnapshot = snapshot;
  }

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    this.readSheets.push(sheetName);
    return cloneSnapshot(this.snapshot);
  }

  async readCanonicalSheet(sheetName: string): Promise<SheetSnapshot> {
    this.readSheets.push(sheetName);
    return cloneSnapshot(this.canonicalSnapshot ?? this.snapshot);
  }

  async initializeSystemSheets(
    sheetName: string,
    headers: string[],
  ): Promise<InitializeSystemSheetsResult> {
    this.initializedSystemSheets.push({
      sheetName,
      headers: [...headers],
    });

    return {
      logicalSheetName: sheetName,
      canonicalSheetName: `_typed_sheets_data_${sheetName}`,
      projectionSheetName: sheetName,
      taskQueueSheetName: "_typed_sheets_task_queue",
    };
  }

  async enqueueTasks(input: EnqueueTasksInput): Promise<EnqueueTasksResult> {
    if (this.enqueueError !== null) {
      throw this.enqueueError;
    }

    this.enqueuedTasks.push({
      tasks: input.tasks.map((task) => ({ ...task })),
    });

    if (this.enqueueErrorAfterRecord !== null) {
      const error = this.enqueueErrorAfterRecord;
      this.enqueueErrorAfterRecord = null;
      throw error;
    }

    return {
      tasks: input.tasks.map((task, index) => ({
        taskId: task.taskId,
        sequence: index + 1,
      })),
    };
  }

  async processTaskQueue(
    input?: ProcessTaskQueueInput,
  ): Promise<ProcessTaskQueueResult> {
    this.processedTaskQueues.push(input ?? {});
    return this.processResult;
  }
}

describe("queued repository transaction API", () => {
  const columns = {
    id: text(),
    userId: text(),
    status: text(),
    canceledAt: text().optional(),
    _version: number(),
  };

  const ordersSnapshot: SheetSnapshot = {
    headers: ["id", "userId", "status", "canceledAt", "_version"],
    rows: [
      { rowNumber: 2, cells: ["o1", "u1", "paid", null, 3] },
      { rowNumber: 3, cells: ["o2", "u1", "paid", null, 1] },
    ],
  };

  it("flushes a successful callback as one queue transaction", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    const result = await orders.transaction(async (tx) => {
      const order = await tx.findById("o1");

      if (order === null) {
        throw new Error("Expected order");
      }

      order.status = "canceled";
      order.canceledAt = "2026-07-09T00:00:00.000Z";
      tx.save(order);

      return "saved";
    });

    expect(result).toBe("saved");
    expect(adapter.enqueuedTasks).toHaveLength(1);
    expect(adapter.enqueuedTasks[0]?.tasks).toHaveLength(1);

    const task = adapter.enqueuedTasks[0]?.tasks[0];
    expect(task).toMatchObject({
      operation: "update",
      transactionIndex: 0,
      keyValue: "o1",
      expectedVersion: 3,
    });
    expect(JSON.parse(task?.payloadJson ?? "{}")).toEqual({
      expectedVersion: 3,
      rowToWrite: {
        id: "o1",
        userId: "u1",
        status: "canceled",
        canceledAt: "2026-07-09T00:00:00.000Z",
        _version: 4,
      },
    });
  });

  it("does not enqueue when the transaction callback throws", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await expect(
      orders.transaction(async (tx) => {
        const order = await tx.findById("o1");

        if (order === null) {
          throw new Error("Expected order");
        }

        tx.save(order);
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("groups multiple entity mutations into one queue transaction", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await orders.transaction(async (tx) => {
      const firstOrder = await tx.findById("o1");
      const secondOrder = await tx.findById("o2");

      if (firstOrder === null || secondOrder === null) {
        throw new Error("Expected orders");
      }

      firstOrder.status = "canceled";
      tx.save(firstOrder);
      tx.remove(secondOrder);
    });

    const tasks = adapter.enqueuedTasks[0]?.tasks ?? [];
    expect(tasks.map((task) => task.operation)).toEqual(["update", "delete"]);
    expect(tasks.map((task) => task.transactionIndex)).toEqual([0, 1]);
    expect(new Set(tasks.map((task) => task.transactionId))).toHaveLength(1);
  });

  it("does not expose entity operations outside a transaction", () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    expect(orders).not.toHaveProperty("findAll");
    expect(orders).not.toHaveProperty("findById");
    expect(orders).not.toHaveProperty("save");
    expect(orders).not.toHaveProperty("remove");
    expect(orders.transaction).toBeTypeOf("function");
  });

  it("rejects a stale entity within its transaction", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await expect(
      orders.transaction(async (tx) => {
        const order = await tx.findById("o1");

        if (order === null) {
          throw new Error("Expected order");
        }

        adapter.setSnapshot({
          headers: ordersSnapshot.headers,
          rows: [ordersSnapshot.rows[1]!],
        });
        tx.save(order);
      }),
    ).rejects.toThrow("Stale entity");

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("applies pending transaction mutations to reads inside the transaction", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await orders.transaction(async (tx) => {
      const newOrder: Order = {
        id: "o3",
        userId: "u1",
        status: "created",
        canceledAt: undefined,
        _version: 1,
      };

      tx.save(newOrder);

      await expect(tx.findById("o3")).resolves.toEqual(newOrder);
    });
  });

  it("cancels a new entity saved and removed in the same transaction", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const newOrder: Order = {
      id: "o3",
      userId: "u1",
      status: "created",
      canceledAt: undefined,
      _version: 1,
    };

    await orders.transaction((tx) => {
      tx.save(newOrder);
      tx.remove(newOrder);
    });

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects changing the key of a loaded entity", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await expect(
      orders.transaction(async (tx) => {
        const order = await tx.findById("o1");

        if (order === null) {
          throw new Error("Expected order");
        }

        order.id = "o3";
        tx.save(order);
      }),
    ).rejects.toThrow('Entity key cannot be changed from "o1" to "o3"');

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects changing the key of an entity returned from the pending overlay", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await expect(
      orders.transaction(async (tx) => {
        const order = await tx.findById("o1");

        if (order === null) {
          throw new Error("Expected order");
        }

        order.status = "canceled";
        tx.save(order);

        const overlayOrder = await tx.findById("o1");

        if (overlayOrder === null) {
          throw new Error("Expected pending order");
        }

        overlayOrder.id = "o3";
        tx.save(overlayOrder);
      }),
    ).rejects.toThrow('Entity key cannot be changed from "o1" to "o3"');

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects changing the key of a new entity after its first save", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const newOrder: Order = {
      id: "o3",
      userId: "u1",
      status: "created",
      canceledAt: undefined,
      _version: 1,
    };

    await expect(
      orders.transaction((tx) => {
        tx.save(newOrder);
        newOrder.id = "o4";
        tx.save(newOrder);
      }),
    ).rejects.toThrow('Entity key cannot be changed from "o3" to "o4"');

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("reads canonical state rather than the visible projection", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    adapter.setCanonicalSnapshot({
      headers: ordersSnapshot.headers,
      rows: [{ rowNumber: 2, cells: ["o1", "u1", "canceled", null, 4] }],
    });
    const orders = createOrdersRepository(adapter);

    await expect(
      orders.transaction((tx) => tx.findById("o1")),
    ).resolves.toEqual({
      id: "o1",
      userId: "u1",
      status: "canceled",
      canceledAt: undefined,
      _version: 4,
    });
  });

  it("initializes the gateway-owned system sheets", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await orders.ensureSheet();

    expect(adapter.initializedSystemSheets).toEqual([
      {
        sheetName: "Orders",
        headers: ["id", "userId", "status", "canceledAt", "_version"],
      },
    ]);
  });

  it("rejects a queued schema without _version before gateway initialization", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const invalidColumns = {
      id: text(),
      userId: text(),
      status: text(),
      canceledAt: text().optional(),
    } as unknown as typeof columns;
    const orders = createQueuedSheetRepository<Order>({
      adapter,
      sheetName: "Orders",
      key: "id",
      columns: invalidColumns,
    });

    await expect(orders.ensureSheet()).rejects.toThrow(
      'Missing version column "_version"',
    );
    expect(adapter.initializedSystemSheets).toEqual([]);
  });

  it("exposes queue processing separately from repository transactions", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const processor = createQueuedRepositoryQueueProcessor(adapter);

    await expect(
      processor.processTaskQueue({ maxTransactions: 1 }),
    ).resolves.toEqual(adapter.processResult);
    expect(adapter.processedTaskQueues).toEqual([{ maxTransactions: 1 }]);
  });

  it("rejects mutations through a transaction handle after the callback ends", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    let escapedTransaction: {
      save(row: Order): void;
    } | null = null;

    await orders.transaction((transaction) => {
      escapedTransaction = transaction;
    });

    if (escapedTransaction === null) {
      throw new Error("Expected transaction handle to be captured");
    }

    expect(() => escapedTransaction?.save({
      id: "o2",
      userId: "u2",
      status: "new",
      canceledAt: undefined,
      _version: 1,
    })).toThrow("Queued repository transaction scope is closed");
  });

  it.each([
    [
      "idle",
      {
        processedTransactions: 0,
        failedTransactions: 0,
        processedTasks: 0,
        failedTasks: 0,
        remainingPendingTasks: 0,
      },
    ],
    [
      "processed",
      {
        processedTransactions: 1,
        failedTransactions: 0,
        processedTasks: 1,
        failedTasks: 0,
        remainingPendingTasks: 0,
      },
    ],
    [
      "pending",
      {
        processedTransactions: 1,
        failedTransactions: 0,
        processedTasks: 1,
        failedTasks: 0,
        remainingPendingTasks: 1,
      },
    ],
    [
      "failed",
      {
        processedTransactions: 0,
        failedTransactions: 1,
        processedTasks: 0,
        failedTasks: 1,
        remainingPendingTasks: 0,
      },
    ],
    [
      "recovering",
      {
        processedTransactions: 0,
        failedTransactions: 0,
        processedTasks: 0,
        failedTasks: 0,
        remainingPendingTasks: 0,
        recoveryPendingTasks: 1,
      },
    ],
  ])("summarizes a %s processor result", (status, result) => {
    expect(summarizeProcessTaskQueueResult(result)).toMatchObject({ status });

    if (status === "recovering") {
      expect(summarizeProcessTaskQueueResult(result)).toMatchObject({
        hasPendingTasks: false,
        hasRecoveryTasks: true,
      });
    }
  });

  function createOrdersRepository(adapter: AppsScriptQueueAdapter) {
    return createQueuedSheetRepository<Order>({
      adapter,
      sheetName: "Orders",
      key: "id",
      columns,
    });
  }
});

function cloneSnapshot(snapshot: SheetSnapshot): SheetSnapshot {
  return {
    headers: [...snapshot.headers],
    rows: snapshot.rows.map((row) => ({
      rowNumber: row.rowNumber,
      cells: [...row.cells],
    })),
  };
}
