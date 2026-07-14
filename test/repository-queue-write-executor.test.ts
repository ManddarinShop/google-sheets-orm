import { describe, expect, it } from "vitest";

import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
  EnqueueTasksResult,
  InitializeSystemSheetsResult,
  ProcessTaskQueueResult,
  SheetSnapshot,
} from "../src/adapter/Adapter.js";
import { ConflictError, SchemaDriftError } from "../src/core/errors/index.js";
import {
  createQueuedRepositoryTransactionCoordinator,
} from "../src/core/queued/transaction/QueuedRepositoryTransactionCoordinator.js";
import {
  createRepositoryQueueWriteExecutor,
  type RepositoryWriteTransactionOperation,
} from "../src/core/write/index.js";
import { boolean, number, text } from "../src/core/schema/index.js";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

class FakeQueueAdapter implements AppsScriptQueueAdapter {
  readonly enqueuedTasks: EnqueueTasksInput[] = [];
  readonly readSheets: string[] = [];
  enqueueError: Error | null = null;
  enqueueErrorAfterRecord: Error | null = null;
  enqueueResult: EnqueueTasksResult | null = null;

  constructor(private readonly snapshot: SheetSnapshot) {}

  async readSheet(sheetName: string): Promise<SheetSnapshot> {
    this.readSheets.push(sheetName);
    return cloneSnapshot(this.snapshot);
  }

  async readCanonicalSheet(sheetName: string): Promise<SheetSnapshot> {
    return this.readSheet(sheetName);
  }

  async initializeSystemSheets(
    _sheetName: string,
    _headers: string[],
  ): Promise<InitializeSystemSheetsResult> {
    throw new Error("Unexpected initializeSystemSheets call");
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

    return this.enqueueResult ?? {
      tasks: input.tasks.map((task, index) => ({
        taskId: task.taskId,
        sequence: index + 1,
      })),
    };
  }

  async processTaskQueue(): Promise<ProcessTaskQueueResult> {
    throw new Error("Unexpected processTaskQueue call");
  }
}

describe("queued write executor and coordinator", () => {
  const columns = {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  };

  const emptyUsers: SheetSnapshot = {
    headers: ["id", "email", "age", "active", "_version"],
    rows: [],
  };

  const usersWithRows: SheetSnapshot = {
    headers: ["id", "email", "age", "active", "_version"],
    rows: [
      { rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] },
      { rowNumber: 3, cells: ["u2", "b@test.com", null, false, 3] },
    ],
  };

  it("uses random transaction ids when the coordinator has no factory", () => {
    const first = createCoordinator(new FakeQueueAdapter(emptyUsers));
    const second = createCoordinator(new FakeQueueAdapter(emptyUsers));

    const firstId = first.createTransactionId();
    const secondId = second.createTransactionId();

    expect(firstId).toMatch(/^tx-[0-9a-f-]{36}$/);
    expect(secondId).toMatch(/^tx-[0-9a-f-]{36}$/);
    expect(firstId).not.toBe(secondId);
  });

  it("materializes an insert without enqueueing it", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    const executor = createExecutor(adapter);

    const materialized = await executor.materializeQueueBatch(
      [
        {
          kind: "insert",
          row: {
            id: "u1",
            email: "a@test.com",
            age: undefined,
            active: true,
            _version: 1,
          },
        },
      ],
      { transactionId: "tx-insert" },
    );

    expect(materialized.results).toEqual([undefined]);
    expect(materialized.tasks?.tasks[0]).toMatchObject({
      taskId: "tx-insert-0",
      transactionId: "tx-insert",
      operation: "insert",
      expectedVersion: null,
      keyValue: "u1",
    });
    expect(materialized.fingerprint).toEqual(expect.any(String));
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("materializes mixed operations from one canonical snapshot", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createExecutor(adapter);

    const materialized = await executor.materializeQueueBatch(
      [
        {
          kind: "insert",
          row: {
            id: "u3",
            email: "c@test.com",
            age: 22,
            active: true,
            _version: 1,
          },
        },
        {
          kind: "update",
          id: "u2",
          updater: (current) => ({
            ...current,
            email: "b-next@test.com",
          }),
        },
        {
          kind: "delete",
          id: "u1",
        },
      ],
      { transactionId: "tx-mixed" },
    );

    expect(adapter.readSheets).toEqual(["Users"]);
    expect(materialized.results[0]).toBeUndefined();
    expect(materialized.results[1]).toMatchObject({
      id: "u2",
      email: "b-next@test.com",
      _version: 4,
    });
    expect(materialized.results[2]).toMatchObject({ id: "u1", _version: 1 });
    expect(materialized.tasks?.tasks.map((task) => task.operation)).toEqual([
      "insert",
      "update",
      "delete",
    ]);
  });

  it("uses earlier operations as state for later operations", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    const executor = createExecutor(adapter);

    const materialized = await executor.materializeQueueBatch(
      [
        {
          kind: "insert",
          row: {
            id: "u1",
            email: "a@test.com",
            age: 20,
            active: true,
            _version: 1,
          },
        },
        {
          kind: "update",
          id: "u1",
          updater: (current) => ({
            ...current,
            email: "a-next@test.com",
          }),
        },
      ],
      { transactionId: "tx-sequential" },
    );

    expect(materialized.results[1]).toMatchObject({
      id: "u1",
      email: "a-next@test.com",
      _version: 2,
    });
    expect(materialized.tasks?.tasks[1]).toMatchObject({
      operation: "update",
      expectedVersion: 1,
      keyValue: "u1",
    });
  });

  it("rejects duplicate inserts before enqueueing", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createExecutor(adapter);

    await expect(
      executor.materializeQueueBatch(
        [
          {
            kind: "insert",
            row: {
              id: "u1",
              email: "duplicate@test.com",
              age: 21,
              active: false,
              _version: 1,
            },
          },
        ],
        { transactionId: "tx-duplicate" },
      ),
    ).rejects.toBeInstanceOf(SchemaDriftError);

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects a stale update before enqueueing", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createExecutor(adapter);

    await expect(
      executor.materializeQueueBatch(
        [
          {
            kind: "update",
            id: "u1",
            expectedVersion: 0,
            updater: (current) => ({
              ...current,
              email: "stale@test.com",
            }),
          },
        ],
        { transactionId: "tx-stale" },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("retains and retries the exact batch after an ambiguous enqueue", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");
    const coordinator = createCoordinator(adapter);
    const operation: RepositoryWriteTransactionOperation<User> = {
      kind: "insert",
      row: {
        id: "u1",
        email: "a@test.com",
        age: undefined,
        active: true,
        _version: 1,
      },
    };

    await expect(
      coordinator.writeTransaction([operation], {
        transactionId: "tx-ambiguous",
      }),
    ).rejects.toThrow("enqueue response lost");

    await expect(
      coordinator.retryTransaction("tx-ambiguous"),
    ).resolves.toEqual([undefined]);

    expect(adapter.enqueuedTasks).toHaveLength(2);
    expect(adapter.enqueuedTasks[1]).toEqual(adapter.enqueuedTasks[0]);
  });

  it("retains a batch when the enqueue response omits a requested task", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    adapter.enqueueResult = { tasks: [] };
    const coordinator = createCoordinator(adapter);
    const operation: RepositoryWriteTransactionOperation<User> = {
      kind: "insert",
      row: {
        id: "u1",
        email: "a@test.com",
        age: undefined,
        active: true,
        _version: 1,
      },
    };

    await expect(
      coordinator.writeTransaction([operation], {
        transactionId: "tx-invalid-enqueue-response",
      }),
    ).rejects.toThrow(/does not match the requested task batch/);

    adapter.enqueueResult = null;

    await expect(
      coordinator.retryTransaction("tx-invalid-enqueue-response"),
    ).resolves.toEqual([undefined]);
    expect(adapter.enqueuedTasks).toHaveLength(2);
  });

  it("expires retained batches so ambiguous failures do not accumulate", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    adapter.enqueueErrorAfterRecord = new Error("first response lost");
    let now = 0;
    const coordinator = createCoordinator(adapter, undefined, {
      retainedBatchTtlMs: 1000,
      now: () => now,
    });
    const operation: RepositoryWriteTransactionOperation<User> = {
      kind: "insert",
      row: {
        id: "u1",
        email: "a@test.com",
        age: undefined,
        active: true,
        _version: 1,
      },
    };

    await expect(
      coordinator.writeTransaction([operation], {
        transactionId: "tx-expired",
      }),
    ).rejects.toThrow("first response lost");

    now = 1000;

    await expect(
      coordinator.retryTransaction("tx-expired"),
    ).rejects.toThrow("has no retained materialized batch");
  });

  it("bounds the number of retained ambiguous batches", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    let now = 0;
    const coordinator = createCoordinator(adapter, undefined, {
      maxRetainedBatches: 1,
      now: () => now,
    });
    const createOperation = (id: string): RepositoryWriteTransactionOperation<User> => ({
      kind: "insert",
      row: {
        id,
        email: `${id}@test.com`,
        age: undefined,
        active: true,
        _version: 1,
      },
    });

    adapter.enqueueErrorAfterRecord = new Error("first response lost");
    await expect(
      coordinator.writeTransaction([createOperation("u1")], {
        transactionId: "tx-first",
      }),
    ).rejects.toThrow("first response lost");

    now = 1;
    adapter.enqueueErrorAfterRecord = new Error("second response lost");
    await expect(
      coordinator.writeTransaction([createOperation("u2")], {
        transactionId: "tx-second",
      }),
    ).rejects.toThrow("second response lost");

    await expect(
      coordinator.retryTransaction("tx-first"),
    ).rejects.toThrow("has no retained materialized batch");
    await expect(
      coordinator.retryTransaction("tx-second"),
    ).resolves.toEqual([undefined]);
  });

  it("rejects a different batch for a retained transaction identity", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    adapter.enqueueErrorAfterRecord = new Error("enqueue response lost");
    const coordinator = createCoordinator(adapter);

    const firstOperation: RepositoryWriteTransactionOperation<User> = {
      kind: "update",
      id: "u1",
      expectedVersion: 1,
      updater: (current) => ({ ...current, email: "first@test.com" }),
    };
    const secondOperation: RepositoryWriteTransactionOperation<User> = {
      kind: "update",
      id: "u1",
      expectedVersion: 1,
      updater: (current) => ({ ...current, email: "second@test.com" }),
    };

    await expect(
      coordinator.writeTransaction([firstOperation], {
        transactionId: "tx-different",
      }),
    ).rejects.toThrow("enqueue response lost");

    await expect(
      coordinator.writeTransaction([secondOperation], {
        transactionId: "tx-different",
      }),
    ).rejects.toThrow("different materialized task batch");

    expect(adapter.enqueuedTasks).toHaveLength(1);
  });

  function createExecutor(adapter: AppsScriptQueueAdapter) {
    return createRepositoryQueueWriteExecutor<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
      createTaskId: ({ transactionId, transactionIndex }) =>
        `${transactionId}-${transactionIndex}`,
    });
  }

  function createCoordinator(
    adapter: AppsScriptQueueAdapter,
    createTransactionId?: () => string,
    options?: {
      maxRetainedBatches?: number;
      retainedBatchTtlMs?: number;
      now?(): number;
    },
  ) {
    const executor = createExecutor(adapter);

    if (createTransactionId === undefined) {
      return createQueuedRepositoryTransactionCoordinator({
        executor,
        ...options,
      });
    }

    return createQueuedRepositoryTransactionCoordinator({
      executor,
      createTransactionId,
      ...options,
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
