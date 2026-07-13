import { describe, expect, it } from "vitest";

import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
  EnqueueTasksResult,
  InitializeSystemSheetsResult,
  ProcessTaskQueueResult,
  SheetSnapshot,
} from "../src/adapter/Adapter.js";
import { ConflictError } from "../src/core/errors/index.js";
import { number, text } from "../src/core/schema/index.js";
import {
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
  readonly readSheets: Array<string> = [];
  readonly initializedSystemSheets: Array<{
    sheetName: string;
    headers: Array<string>;
  }> = [];
  readonly processedTaskQueues: Array<unknown> = [];
  enqueueError: Error | null = null;
  enqueueErrorAfterRecord: Error | null = null;
  private canonicalSnapshot: SheetSnapshot | null = null;
  processResult: ProcessTaskQueueResult = {
    processedTransactions: 1,
    failedTransactions: 0,
    processedTasks: 1,
    failedTasks: 0,
    remainingPendingTasks: 0,
  };

  constructor(private snapshot: SheetSnapshot) {}

  setSnapshot(snapshot: SheetSnapshot): void {
    this.snapshot = snapshot;
  }

  setCanonicalSnapshot(snapshot: SheetSnapshot): void {
    this.canonicalSnapshot = snapshot;
  }

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    this.readSheets.push(sheetName);

    return {
      headers: [...this.snapshot.headers],
      rows: this.snapshot.rows.map((row) => ({
        rowNumber: row.rowNumber,
        cells: [...row.cells],
      })),
    };
  }

  async readCanonicalSheet(sheetName: string): Promise<SheetSnapshot> {
    if (this.canonicalSnapshot === null) {
      return this.readSheet(sheetName);
    }

    this.readSheets.push(sheetName);

    return {
      headers: [...this.canonicalSnapshot.headers],
      rows: this.canonicalSnapshot.rows.map((row) => ({
        rowNumber: row.rowNumber,
        cells: [...row.cells],
      })),
    };
  }

  async initializeSystemSheets(
    sheetName: string,
    headers: Array<string>,
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

  async processTaskQueue(input?: unknown): Promise<ProcessTaskQueueResult> {
    this.processedTaskQueues.push(input ?? {});

    return this.processResult;
  }
}

describe("queued repository transactions", () => {
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

  it("auto-flushes writes when the transaction callback succeeds", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await orders.transaction(async (tx) => {
      const order = await tx.findById("o1");

      if (order === null || order.userId !== "u1") {
        throw new Error("Order not found");
      }

      order.status = "canceled";
      order.canceledAt = "2026-07-09T00:00:00.000Z";

      tx.save(order);
    });

    expect(adapter.enqueuedTasks).toEqual([
      {
        tasks: [
          {
            taskId: expect.any(String),
            transactionId: expect.any(String),
            transactionIndex: 0,
            sheetName: "Orders",
            keyHeader: "id",
            keyValue: "o1",
            operation: "update",
            expectedVersion: 3,
            payloadJson: JSON.stringify({
              expectedVersion: 3,
              rowToWrite: {
                id: "o1",
                userId: "u1",
                status: "canceled",
                canceledAt: "2026-07-09T00:00:00.000Z",
                _version: 4,
              },
            }),
          },
        ],
      },
    ]);
  });

  it("does not flush when the transaction callback throws", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);

    await expect(
      orders.transaction(async (tx) => {
        const order = await tx.findById("o1");

        if (order === null) {
          throw new Error("Order not found");
        }

        order.status = "canceled";
        tx.save(order);

        throw new Error("cancel failed");
      }),
    ).rejects.toThrow(/cancel failed/);

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("snapshots saved rows when they are queued", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    order.status = "mutated-after-save";

    await tx.flush();

    expect(JSON.parse(adapter.enqueuedTasks[0]?.tasks[0]?.payloadJson ?? "{}"))
      .toEqual({
        expectedVersion: 3,
        rowToWrite: {
          id: "o1",
          userId: "u1",
          status: "canceled",
          canceledAt: null,
          _version: 4,
        },
      });
  });

  it("defers transaction update updaters until flush reads the latest snapshot", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();

    tx.update("o1", (current) => ({
      ...current,
      status: `${current.status}-canceled`,
    }));
    adapter.setSnapshot({
      headers: ["id", "userId", "status", "canceledAt", "_version"],
      rows: [
        { rowNumber: 2, cells: ["o1", "u1", "refunded", null, 4] },
      ],
    });

    await expect(tx.flush()).resolves.toEqual([
      {
        id: "o1",
        userId: "u1",
        status: "refunded-canceled",
        canceledAt: undefined,
        _version: 5,
      },
    ]);

    expect(JSON.parse(adapter.enqueuedTasks[0]?.tasks[0]?.payloadJson ?? "{}"))
      .toEqual({
        expectedVersion: 4,
        rowToWrite: {
          id: "o1",
          userId: "u1",
          status: "refunded-canceled",
          canceledAt: null,
          _version: 5,
        },
      });
  });

  it("coalesces repeated saves for one entity into one queued update", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    order.status = "archived";
    tx.save(order);

    await tx.flush();

    expect(adapter.enqueuedTasks).toHaveLength(1);
    expect(adapter.enqueuedTasks[0]?.tasks).toHaveLength(1);
    expect(adapter.enqueuedTasks[0]?.tasks[0]?.operation).toBe("update");
    expect(JSON.parse(adapter.enqueuedTasks[0]?.tasks[0]?.payloadJson ?? "{}"))
      .toEqual({
        expectedVersion: 3,
        rowToWrite: {
          id: "o1",
          userId: "u1",
          status: "archived",
          canceledAt: null,
          _version: 4,
        },
      });
  });

  it("coalesces insert followed by remove into no queued task", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = {
      id: "o3",
      userId: "u1",
      status: "created",
      canceledAt: undefined,
      _version: 1,
    };

    tx.insert(order);
    tx.remove(order);

    await expect(tx.flush()).resolves.toEqual([]);
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("coalesces remove followed by save into one queued update", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    tx.remove(order);
    order.status = "restored";
    tx.save(order);

    await tx.flush();

    expect(adapter.enqueuedTasks).toHaveLength(1);
    expect(adapter.enqueuedTasks[0]?.tasks).toHaveLength(1);
    expect(adapter.enqueuedTasks[0]?.tasks[0]?.operation).toBe("update");
    expect(JSON.parse(adapter.enqueuedTasks[0]?.tasks[0]?.payloadJson ?? "{}"))
      .toEqual({
        expectedVersion: 3,
        rowToWrite: {
          id: "o1",
          userId: "u1",
          status: "restored",
          canceledAt: null,
          _version: 4,
        },
      });
  });

  it("keeps pending operations when flush fails so callers can retry", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    adapter.enqueueError = new Error("enqueue failed");

    await expect(tx.flush()).rejects.toThrow(/enqueue failed/);
    expect(adapter.enqueuedTasks).toEqual([]);

    adapter.enqueueError = null;
    await expect(tx.flush()).resolves.toHaveLength(1);
    expect(adapter.enqueuedTasks).toHaveLength(1);
  });

  it("reuses the exact enqueue batch when the response is lost", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(tx.flush()).rejects.toThrow(/enqueue response lost/);

    await expect(tx.flush()).resolves.toHaveLength(1);

    expect(adapter.enqueuedTasks).toHaveLength(2);
    expect(adapter.enqueuedTasks[1]).toEqual(adapter.enqueuedTasks[0]);
  });

  it("reuses the exact enqueue batch after the processor applies it", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction({ transactionId: "tx-processed-retry" });
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(tx.flush()).rejects.toThrow(/enqueue response lost/);

    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [
        { rowNumber: 2, cells: ["o1", "u1", "canceled", null, 4] },
        { rowNumber: 3, cells: ["o2", "u1", "paid", null, 1] },
      ],
    });

    await expect(tx.flush()).resolves.toHaveLength(1);
    expect(adapter.enqueuedTasks).toHaveLength(2);
    expect(adapter.enqueuedTasks[1]).toEqual(adapter.enqueuedTasks[0]);
    expect(adapter.readSheets).toHaveLength(2);
  });

  it("reuses a high-level transaction batch when retried with the same identity", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const transactionId = "tx-high-level-retry";

    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(
      orders.transaction(
        async (tx) => {
          const order = await tx.findById("o1");

          if (order === null) {
            throw new Error("Expected order");
          }

          order.status = "canceled";
          tx.save(order);
          return "saved";
        },
        { transactionId },
      ),
    ).rejects.toThrow(/enqueue response lost/);

    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [
        { rowNumber: 2, cells: ["o1", "u1", "canceled", null, 4] },
        { rowNumber: 3, cells: ["o2", "u1", "paid", null, 1] },
      ],
    });

    await expect(
      orders.transaction(
        async (tx) => {
          const order = await tx.findById("o1");

          if (order === null) {
            throw new Error("Expected order");
          }

          order.status = "canceled";
          tx.save(order);
          return "saved";
        },
        { transactionId },
      ),
    ).resolves.toBe("saved");

    expect(adapter.enqueuedTasks).toHaveLength(2);
    expect(adapter.enqueuedTasks[1]).toEqual(adapter.enqueuedTasks[0]);
  });

  it("rejects a high-level retry when the callback creates different tasks", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const transactionId = "tx-high-level-different-retry";

    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(
      orders.transaction(
        async (tx) => {
          const order = await tx.findById("o1");

          if (order === null) {
            throw new Error("Expected order");
          }

          order.status = "canceled";
          tx.save(order);
        },
        { transactionId },
      ),
    ).rejects.toThrow(/enqueue response lost/);

    await expect(
      orders.transaction(
        async (tx) => {
          const order = await tx.findById("o1");

          if (order === null) {
            throw new Error("Expected order");
          }

          order.status = "refunded";
          tx.save(order);
        },
        { transactionId },
      ),
    ).rejects.toThrow(/different materialized task batch/);

    expect(adapter.enqueuedTasks).toHaveLength(1);
  });

  it("reuses a convenience update batch with a stable transaction identity", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const transactionId = "tx-convenience-retry";
    const updater = (current: Order): Order => ({
      ...current,
      status: "canceled",
    });

    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(
      orders.update("o1", updater, { transactionId }),
    ).rejects.toThrow(/enqueue response lost/);

    await expect(
      orders.update("o1", updater, { transactionId }),
    ).resolves.toEqual({
      id: "o1",
      userId: "u1",
      status: "canceled",
      canceledAt: undefined,
      _version: 4,
    });

    expect(adapter.enqueuedTasks).toHaveLength(2);
    expect(adapter.enqueuedTasks[1]).toEqual(adapter.enqueuedTasks[0]);
    expect(adapter.readSheets).toHaveLength(1);
  });

  it("retries a convenience delete after the processor removed the row", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const transactionId = "tx-convenience-delete-retry";

    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(
      orders.deleteById("o1", { transactionId }),
    ).rejects.toThrow(/enqueue response lost/);

    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [
        { rowNumber: 2, cells: ["o2", "u1", "paid", null, 1] },
      ],
    });

    await expect(
      orders.deleteById("o1", { transactionId }),
    ).resolves.toEqual({
      id: "o1",
      userId: "u1",
      status: "paid",
      canceledAt: undefined,
      _version: 3,
    });

    expect(adapter.enqueuedTasks).toHaveLength(2);
    expect(adapter.enqueuedTasks[1]).toEqual(adapter.enqueuedTasks[0]);
  });

  it("rejects mutations while a flush retry is pending", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");

    await expect(tx.flush()).rejects.toThrow(/enqueue response lost/);

    order.status = "restored";
    expect(() => tx.save(order)).toThrow(/flush retry is pending/);

    await expect(tx.flush()).resolves.toHaveLength(1);
  });

  it("can flush and return the queue processor response", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);

    await expect(
      tx.flushAndProcessQueue({ maxTransactions: 1 }),
    ).resolves.toEqual({
      writeResults: [
        {
          id: "o1",
          userId: "u1",
          status: "canceled",
          canceledAt: undefined,
          _version: 4,
        },
      ],
      processResult: {
        processedTransactions: 1,
        failedTransactions: 0,
        processedTasks: 1,
        failedTasks: 0,
        remainingPendingTasks: 0,
      },
      processing: {
        status: "processed",
        processedAny: true,
        hasFailures: false,
        hasPendingTasks: false,
      },
    });
    expect(adapter.enqueuedTasks).toHaveLength(1);
    expect(adapter.processedTaskQueues).toEqual([{ maxTransactions: 1 }]);
  });

  it("summarizes pending queue processor responses", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();

    adapter.processResult = {
      processedTransactions: 1,
      failedTransactions: 0,
      processedTasks: 2,
      failedTasks: 0,
      remainingPendingTasks: 3,
    };

    await expect(tx.flushAndProcessQueue()).resolves.toMatchObject({
      writeResults: [],
      processing: {
        status: "pending",
        processedAny: true,
        hasFailures: false,
        hasPendingTasks: true,
      },
    });
  });

  it("rejects save when the entity version is stale at flush", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [
        { rowNumber: 2, cells: ["o1", "u1", "refunded", null, 4] },
        { rowNumber: 3, cells: ["o2", "u1", "paid", null, 1] },
      ],
    });

    await expect(tx.flush()).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects remove when the entity version is stale at flush", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    tx.remove(order);
    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [
        { rowNumber: 2, cells: ["o1", "u1", "refunded", null, 4] },
        { rowNumber: 3, cells: ["o2", "u1", "paid", null, 1] },
      ],
    });

    await expect(tx.flush()).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects save when the loaded entity was deleted before flush", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [{ rowNumber: 2, cells: ["o2", "u1", "paid", null, 1] }],
    });

    await expect(tx.flush()).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects remove when the loaded entity was deleted before flush", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    tx.remove(order);
    adapter.setSnapshot({
      headers: ordersSnapshot.headers,
      rows: [{ rowNumber: 2, cells: ["o2", "u1", "paid", null, 1] }],
    });

    await expect(tx.flush()).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("summarizes failed queue processor responses", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();

    adapter.processResult = {
      processedTransactions: 0,
      failedTransactions: 1,
      processedTasks: 0,
      failedTasks: 2,
      remainingPendingTasks: 0,
    };

    await expect(tx.flushAndProcessQueue()).resolves.toMatchObject({
      writeResults: [],
      processing: {
        status: "failed",
        processedAny: false,
        hasFailures: true,
        hasPendingTasks: false,
      },
    });
  });

  it("summarizes idle queue processor responses", () => {
    expect(
      summarizeProcessTaskQueueResult({
        processedTransactions: 0,
        failedTransactions: 0,
        processedTasks: 0,
        failedTasks: 0,
        remainingPendingTasks: 0,
      }),
    ).toEqual({
      status: "idle",
      processedAny: false,
      hasFailures: false,
      hasPendingTasks: false,
    });
  });

  it("reads pending transaction state before flush", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const order = await tx.findById("o1");

    if (order === null) {
      throw new Error("Expected order");
    }

    order.status = "canceled";
    tx.save(order);
    tx.insert({
      id: "o3",
      userId: "u1",
      status: "created",
      canceledAt: undefined,
      _version: 1,
    });
    tx.remove({
      id: "o2",
      userId: "u1",
      status: "paid",
      canceledAt: undefined,
      _version: 1,
    });

    await expect(tx.findById("o1")).resolves.toMatchObject({
      id: "o1",
      status: "canceled",
    });
    await expect(tx.findById("o2")).resolves.toBeNull();
    await expect(tx.findById("o3")).resolves.toMatchObject({
      id: "o3",
      status: "created",
    });
    await expect(tx.findAll()).resolves.toEqual([
      {
        id: "o1",
        userId: "u1",
        status: "canceled",
        canceledAt: undefined,
        _version: 3,
      },
      {
        id: "o3",
        userId: "u1",
        status: "created",
        canceledAt: undefined,
        _version: 1,
      },
    ]);
  });

  it("supports explicit createTransaction plus flush", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    const orders = createOrdersRepository(adapter);
    const tx = orders.createTransaction();
    const firstOrder = await tx.findById("o1");
    const secondOrder = await tx.findById("o2");

    if (firstOrder === null || secondOrder === null) {
      throw new Error("Expected orders");
    }

    tx.remove(firstOrder);
    tx.insert({
      id: "o3",
      userId: "u1",
      status: "created",
      canceledAt: undefined,
      _version: 1,
    });
    secondOrder.status = "canceled";
    secondOrder.canceledAt = "2026-07-09T00:00:00.000Z";
    tx.save(secondOrder);

    await expect(tx.flush()).resolves.toEqual([
      {
        id: "o1",
        userId: "u1",
        status: "paid",
        canceledAt: undefined,
        _version: 3,
      },
      undefined,
      {
        id: "o2",
        userId: "u1",
        status: "canceled",
        canceledAt: "2026-07-09T00:00:00.000Z",
        _version: 2,
      },
    ]);

    expect(adapter.enqueuedTasks).toHaveLength(1);
    expect(adapter.enqueuedTasks[0]?.tasks.map((task) => task.operation)).toEqual([
      "delete",
      "insert",
      "update",
    ]);
    expect(
      new Set(adapter.enqueuedTasks[0]?.tasks.map((task) => task.transactionId)),
    ).toHaveLength(1);
  });

  it("initializes system sheets for queued repositories", async () => {
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

  it("reads canonical state when the queue adapter provides it", async () => {
    const adapter = new FakeQueueAdapter(ordersSnapshot);
    adapter.setCanonicalSnapshot({
      headers: ordersSnapshot.headers,
      rows: [
        { rowNumber: 2, cells: ["o1", "u1", "canceled", null, 4] },
      ],
    });
    const orders = createOrdersRepository(adapter);

    await expect(orders.findById("o1")).resolves.toEqual({
      id: "o1",
      userId: "u1",
      status: "canceled",
      canceledAt: undefined,
      _version: 4,
    });
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
