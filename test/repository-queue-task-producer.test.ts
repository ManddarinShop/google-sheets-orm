import { describe, expect, it } from "vitest";

import { createRepositoryQueueTasks } from "../src/core/write/index.js";

interface User {
  id: string;
  email: string;
  active: boolean;
  _version: number;
}

describe("repository queue task producer", () => {
  it("converts an explicit transaction into ordered queue tasks", () => {
    const result = createRepositoryQueueTasks<User>({
      sheetName: "Users",
      key: "id",
      transaction: {
        id: "tx-1",
        operations: [
          {
            kind: "insert",
            row: {
              id: "u1",
              email: "a@test.com",
              active: true,
              _version: 1,
            },
          },
          {
            kind: "update",
            id: "u2",
            expectedVersion: 3,
            rowToWrite: {
              id: "u2",
              email: "b-next@test.com",
              active: false,
              _version: 4,
            },
          },
          {
            kind: "delete",
            id: "u3",
            expectedVersion: 2,
            rowToDelete: {
              id: "u3",
              email: "c@test.com",
              active: true,
              _version: 2,
            },
          },
        ],
      },
      createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
    });

    expect(result).toEqual({
      tasks: [
        {
          taskId: "task-0",
          transactionId: "tx-1",
          transactionIndex: 0,
          operation: "insert",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u1",
          expectedVersion: null,
          payloadJson: JSON.stringify({
            row: {
              id: "u1",
              email: "a@test.com",
              active: true,
              _version: 1,
            },
          }),
        },
        {
          taskId: "task-1",
          transactionId: "tx-1",
          transactionIndex: 1,
          operation: "update",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u2",
          expectedVersion: 3,
          payloadJson: JSON.stringify({
            expectedVersion: 3,
            rowToWrite: {
              id: "u2",
              email: "b-next@test.com",
              active: false,
              _version: 4,
            },
          }),
        },
        {
          taskId: "task-2",
          transactionId: "tx-1",
          transactionIndex: 2,
          operation: "delete",
          sheetName: "Users",
          keyHeader: "id",
          keyValue: "u3",
          expectedVersion: 2,
          payloadJson: JSON.stringify({
            expectedVersion: 2,
            rowToDelete: {
              id: "u3",
              email: "c@test.com",
              active: true,
              _version: 2,
            },
          }),
        },
      ],
    });
  });

  it("passes explicit transaction context into task id generation", () => {
    const seenInputs: unknown[] = [];

    createRepositoryQueueTasks<User>({
      sheetName: "Users",
      key: "id",
      transaction: {
        id: "tx-abc",
        operations: [
          {
            kind: "insert",
            row: {
              id: "u1",
              email: "a@test.com",
              active: true,
              _version: 1,
            },
          },
        ],
      },
      createTaskId: (input) => {
        seenInputs.push(input);
        return `task-${input.transactionId}-${input.transactionIndex}`;
      },
    });

    expect(seenInputs).toEqual([
      {
        transactionId: "tx-abc",
        transactionIndex: 0,
        operation: {
          kind: "insert",
          row: {
            id: "u1",
            email: "a@test.com",
            active: true,
            _version: 1,
          },
        },
      },
    ]);
  });

  it("rejects queued updates that do not advance version", () => {
    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "update",
              id: "u1",
              expectedVersion: 3,
              rowToWrite: {
                id: "u1",
                email: "a@test.com",
                active: true,
                _version: 3,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/advance _version/);
  });

  it("rejects queued updates when rowToWrite mismatches the id", () => {
    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "update",
              id: "u1",
              expectedVersion: 3,
              rowToWrite: {
                id: "u2",
                email: "a@test.com",
                active: true,
                _version: 4,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/rowToWrite key must match id/);
  });

  it("rejects queued updates with non-finite versions", () => {
    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "update",
              id: "u1",
              expectedVersion: Number.NaN,
              rowToWrite: {
                id: "u1",
                email: "a@test.com",
                active: true,
                _version: 4,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/expectedVersion must be finite/);

    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "update",
              id: "u1",
              expectedVersion: 3,
              rowToWrite: {
                id: "u1",
                email: "a@test.com",
                active: true,
                _version: Number.POSITIVE_INFINITY,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/advance _version/);
  });

  it("rejects queued inserts without a finite numeric version", () => {
    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "insert",
              row: {
                id: "u1",
                email: "a@test.com",
                active: true,
              } as User,
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/finite numeric _version/);

    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "insert",
              row: {
                id: "u1",
                email: "a@test.com",
                active: true,
                _version: Number.NaN,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/finite numeric _version/);
  });

  it("rejects queued deletes when rowToDelete mismatches the id", () => {
    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "delete",
              id: "u1",
              expectedVersion: 2,
              rowToDelete: {
                id: "u2",
                email: "a@test.com",
                active: true,
                _version: 2,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/rowToDelete key must match id/);
  });

  it("rejects queued deletes when rowToDelete mismatches expected version", () => {
    expect(() =>
      createRepositoryQueueTasks<User>({
        sheetName: "Users",
        key: "id",
        transaction: {
          id: "tx-1",
          operations: [
            {
              kind: "delete",
              id: "u1",
              expectedVersion: 2,
              rowToDelete: {
                id: "u1",
                email: "a@test.com",
                active: true,
                _version: 3,
              },
            },
          ],
        },
        createTaskId: ({ transactionIndex }) => `task-${transactionIndex}`,
      }),
    ).toThrow(/_version must match expectedVersion/);
  });
});
