import { describe, expect, it } from "vitest";

import type {
  AppsScriptQueueAdapter,
  EnqueueTasksInput,
  EnqueueTasksResult,
  InitializeSystemSheetsResult,
  ProcessTaskQueueResult,
  SheetSnapshot,
} from "../src/adapter/Adapter.js";
import { boolean, number, text } from "../src/core/Columns.js";
import { SchemaDriftError } from "../src/core/Errors.js";
import { createRepositoryQueueWriteExecutor } from "../src/core/RepositoryQueueWriteExecutor.js";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

class FakeQueueAdapter implements AppsScriptQueueAdapter {
  readonly enqueuedTasks: EnqueueTasksInput[] = [];
  readonly readSheets: Array<string> = [];

  constructor(private readonly snapshot: SheetSnapshot) {}

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

  async initializeSystemSheets(): Promise<InitializeSystemSheetsResult> {
    throw new Error("Unexpected initializeSystemSheets call");
  }

  async enqueueTasks(input: EnqueueTasksInput): Promise<EnqueueTasksResult> {
    this.enqueuedTasks.push({
      tasks: input.tasks.map((task) => ({ ...task })),
    });

    return {
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

class BlockingQueueAdapter extends FakeQueueAdapter {
  private readIndex = 0;
  private readonly pendingEnqueueResolves: Array<() => void> = [];

  constructor(private readonly snapshots: SheetSnapshot[]) {
    super(snapshots[0] ?? { headers: [], rows: [] });
  }

  override async readSheet(sheetName: string): Promise<SheetSnapshot> {
    this.readSheets.push(sheetName);

    const snapshot =
      this.snapshots[Math.min(this.readIndex, this.snapshots.length - 1)];
    this.readIndex += 1;

    if (snapshot === undefined) {
      throw new Error("Missing controlled snapshot");
    }

    return {
      headers: [...snapshot.headers],
      rows: snapshot.rows.map((row) => ({
        rowNumber: row.rowNumber,
        cells: [...row.cells],
      })),
    };
  }

  override async enqueueTasks(
    input: EnqueueTasksInput,
  ): Promise<EnqueueTasksResult> {
    await new Promise<void>((resolve) => {
      this.pendingEnqueueResolves.push(resolve);
    });

    return super.enqueueTasks(input);
  }

  get pendingEnqueueCount(): number {
    return this.pendingEnqueueResolves.length;
  }

  resolveNextEnqueue(): void {
    const resolve = this.pendingEnqueueResolves.shift();

    if (resolve === undefined) {
      throw new Error("No pending enqueue");
    }

    resolve();
  }
}

describe("repository queue write executor", () => {
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

  it("enqueues inserts as one queue transaction", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    const executor = createQueueExecutor(adapter);

    await expect(
      executor.insertRows([
        {
          id: "u1",
          email: "a@test.com",
          age: undefined,
          active: true,
          _version: 1,
        },
      ]),
    ).resolves.toEqual([undefined]);

    expect(adapter.enqueuedTasks).toEqual([
      {
        tasks: [
          {
            taskId: "tx-1-0",
            transactionId: "tx-1",
            transactionIndex: 0,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            operation: "insert",
            expectedVersion: null,
            payloadJson: JSON.stringify({
              row: {
                id: "u1",
                email: "a@test.com",
                age: null,
                active: true,
                _version: 1,
              },
            }),
          },
        ],
      },
    ]);
  });

  it("enqueues updates with expected version and row to write", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createQueueExecutor(adapter);

    await expect(
      executor.updateRowsById([
        {
          id: "u1",
          updater: (current) => ({
            ...current,
            age: undefined,
          }),
        },
      ]),
    ).resolves.toEqual([
      {
        id: "u1",
        email: "a@test.com",
        age: undefined,
        active: true,
        _version: 2,
      },
    ]);

    expect(adapter.enqueuedTasks).toEqual([
      {
        tasks: [
          {
            taskId: "tx-1-0",
            transactionId: "tx-1",
            transactionIndex: 0,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            operation: "update",
            expectedVersion: 1,
            payloadJson: JSON.stringify({
              expectedVersion: 1,
              rowToWrite: {
                id: "u1",
                email: "a@test.com",
                age: null,
                active: true,
                _version: 2,
              },
            }),
          },
        ],
      },
    ]);
  });

  it("enqueues deletes with previous row evidence", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createQueueExecutor(adapter);

    await expect(executor.deleteRowsById(["u2"])).resolves.toEqual([
      {
        id: "u2",
        email: "b@test.com",
        age: undefined,
        active: false,
        _version: 3,
      },
    ]);

    expect(adapter.enqueuedTasks).toEqual([
      {
        tasks: [
          {
            taskId: "tx-1-0",
            transactionId: "tx-1",
            transactionIndex: 0,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u2",
            operation: "delete",
            expectedVersion: 3,
            payloadJson: JSON.stringify({
              expectedVersion: 3,
              rowToDelete: {
                id: "u2",
                email: "b@test.com",
                age: null,
                active: false,
                _version: 3,
              },
            }),
          },
        ],
      },
    ]);
  });

  it("enqueues mixed writes as one transaction from one snapshot", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createQueueExecutor(adapter);

    await expect(
      executor.writeTransaction([
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
      ]),
    ).resolves.toEqual([
      undefined,
      {
        id: "u2",
        email: "b-next@test.com",
        age: undefined,
        active: false,
        _version: 4,
      },
      {
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      },
    ]);

    expect(adapter.readSheets).toEqual(["Users"]);
    expect(adapter.enqueuedTasks).toEqual([
      {
        tasks: [
          {
            taskId: "tx-1-0",
            transactionId: "tx-1",
            transactionIndex: 0,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u3",
            operation: "insert",
            expectedVersion: null,
            payloadJson: JSON.stringify({
              row: {
                id: "u3",
                email: "c@test.com",
                age: 22,
                active: true,
                _version: 1,
              },
            }),
          },
          {
            taskId: "tx-1-1",
            transactionId: "tx-1",
            transactionIndex: 1,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u2",
            operation: "update",
            expectedVersion: 3,
            payloadJson: JSON.stringify({
              expectedVersion: 3,
              rowToWrite: {
                id: "u2",
                email: "b-next@test.com",
                age: null,
                active: false,
                _version: 4,
              },
            }),
          },
          {
            taskId: "tx-1-2",
            transactionId: "tx-1",
            transactionIndex: 2,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            operation: "delete",
            expectedVersion: 1,
            payloadJson: JSON.stringify({
              expectedVersion: 1,
              rowToDelete: {
                id: "u1",
                email: "a@test.com",
                age: 20,
                active: true,
                _version: 1,
              },
            }),
          },
        ],
      },
    ]);
  });

  it("uses earlier transaction operations as later operation state", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    const executor = createQueueExecutor(adapter);

    await expect(
      executor.writeTransaction([
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
      ]),
    ).resolves.toEqual([
      undefined,
      {
        id: "u1",
        email: "a-next@test.com",
        age: 20,
        active: true,
        _version: 2,
      },
    ]);

    expect(adapter.readSheets).toEqual(["Users"]);
    expect(adapter.enqueuedTasks).toEqual([
      {
        tasks: [
          {
            taskId: "tx-1-0",
            transactionId: "tx-1",
            transactionIndex: 0,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            operation: "insert",
            expectedVersion: null,
            payloadJson: JSON.stringify({
              row: {
                id: "u1",
                email: "a@test.com",
                age: 20,
                active: true,
                _version: 1,
              },
            }),
          },
          {
            taskId: "tx-1-1",
            transactionId: "tx-1",
            transactionIndex: 1,
            sheetName: "Users",
            keyHeader: "id",
            keyValue: "u1",
            operation: "update",
            expectedVersion: 1,
            payloadJson: JSON.stringify({
              expectedVersion: 1,
              rowToWrite: {
                id: "u1",
                email: "a-next@test.com",
                age: 20,
                active: true,
                _version: 2,
              },
            }),
          },
        ],
      },
    ]);
  });

  it("does not enqueue tasks for missing update and delete targets", async () => {
    const adapter = new FakeQueueAdapter(emptyUsers);
    const executor = createQueueExecutor(adapter);

    await expect(
      executor.updateRowsById([
        {
          id: "missing",
          updater: (current) => current,
        },
      ]),
    ).resolves.toEqual([null]);
    await expect(executor.deleteRowsById(["missing"])).resolves.toEqual([null]);

    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("rejects duplicate insert keys before enqueueing", async () => {
    const adapter = new FakeQueueAdapter(usersWithRows);
    const executor = createQueueExecutor(adapter);

    await expect(
      executor.insertRows([
        {
          id: "u1",
          email: "duplicate@test.com",
          age: 21,
          active: false,
          _version: 1,
        },
      ]),
    ).rejects.toThrow(SchemaDriftError);
    expect(adapter.enqueuedTasks).toEqual([]);
  });

  it("serializes overlapping writes before reading snapshots", async () => {
    const adapter = new BlockingQueueAdapter([
      emptyUsers,
      {
        headers: ["id", "email", "age", "active", "_version"],
        rows: [{ rowNumber: 2, cells: ["u1", "a@test.com", 20, true, 1] }],
      },
    ]);
    const executor = createQueueExecutor(adapter);
    const firstInsert = executor.insertRows([
      {
        id: "u1",
        email: "a@test.com",
        age: 20,
        active: true,
        _version: 1,
      },
    ]);
    const secondInsert = executor.insertRows([
      {
        id: "u1",
        email: "duplicate@test.com",
        age: 21,
        active: false,
        _version: 1,
      },
    ]);

    await waitForPendingEnqueue(adapter);

    expect(adapter.readSheets).toEqual(["Users"]);
    expect(adapter.enqueuedTasks).toEqual([]);

    adapter.resolveNextEnqueue();

    await expect(firstInsert).resolves.toEqual([undefined]);
    await expect(secondInsert).rejects.toThrow(SchemaDriftError);
    expect(adapter.readSheets).toEqual(["Users", "Users"]);
    expect(adapter.enqueuedTasks).toHaveLength(1);
  });

  function createQueueExecutor(adapter: AppsScriptQueueAdapter) {
    return createRepositoryQueueWriteExecutor<User>({
      adapter,
      sheetName: "Users",
      key: "id",
      columns,
      createTransactionId: () => "tx-1",
      createTaskId: ({ transactionId, transactionIndex }) =>
        `${transactionId}-${transactionIndex}`,
    });
  }

  async function waitForPendingEnqueue(
    adapter: BlockingQueueAdapter,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (adapter.pendingEnqueueCount > 0) {
        return;
      }

      await Promise.resolve();
    }

    throw new Error("Timed out waiting for pending enqueue");
  }
});
