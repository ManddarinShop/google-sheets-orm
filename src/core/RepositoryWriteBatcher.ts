import type { RepositoryWriteBatcherContext } from "./RepositoryBatching.js";
import {
  createRepositorySyncWriteExecutor,
  type RepositoryUpdateRequest,
  type RepositoryWriteExecutor,
} from "./RepositorySyncWriteExecutor.js";
import { createSameTickBatcher } from "./SameTickBatcher.js";

type RepositoryWriteRequest<T extends Record<string, unknown>> =
  | {
      kind: "insert";
      row: T;
    }
  | ({
      kind: "update";
    } & RepositoryUpdateRequest<T>)
  | {
      kind: "delete";
      id: string;
    };

type RepositoryWriteResult<T extends Record<string, unknown>> =
  | void
  | T
  | null;

interface IndexedWriteRequest<T extends Record<string, unknown>> {
  index: number;
  request: RepositoryWriteRequest<T>;
}

type WriteRequestRun<T extends Record<string, unknown>> = Array<
  IndexedWriteRequest<T>
>;
type WriteRequestKind = "insert" | "update" | "delete";

export interface RepositoryWriteBatcher<T extends Record<string, unknown>> {
  insert(row: T): Promise<void>;
  update(id: string, updater: (current: T) => T): Promise<T | null>;
  deleteById(id: string): Promise<T | null>;
}

/**
 * Batches repository writes through one same-tick queue. Contiguous operations
 * of the same kind are coalesced, while mixed insert/update/delete calls keep
 * their original order so later task-queue executors can preserve write intent.
 */
export function createRepositoryWriteBatcher<
  T extends Record<string, unknown>,
>(
  input: RepositoryWriteBatcherContext<T>,
): RepositoryWriteBatcher<T> {
  const executor = createRepositorySyncWriteExecutor(input);
  const batcher = createSameTickBatcher<
    RepositoryWriteRequest<T>,
    RepositoryWriteResult<T>
  >({
    flush: (requests) => flushWriteRequests(executor, requests),
  });

  return {
    async insert(row) {
      await batcher.enqueue({ kind: "insert", row });
    },

    update(id, updater) {
      return batcher.enqueue({ kind: "update", id, updater }) as Promise<
        T | null
      >;
    },

    deleteById(id) {
      return batcher.enqueue({ kind: "delete", id }) as Promise<T | null>;
    },
  };
}

async function flushWriteRequests<T extends Record<string, unknown>>(
  executor: RepositoryWriteExecutor<T>,
  requests: Array<RepositoryWriteRequest<T>>,
): Promise<Array<RepositoryWriteResult<T>>> {
  const results = new Array<RepositoryWriteResult<T>>(requests.length);
  const runs = createContiguousRuns(requests);

  for (const run of runs) {
    const runResults = await executeWriteRequestRun(executor, run);

    assignRunResults(results, run, runResults);
  }

  return results;
}

async function executeWriteRequestRun<T extends Record<string, unknown>>(
  executor: RepositoryWriteExecutor<T>,
  run: WriteRequestRun<T>,
): Promise<Array<RepositoryWriteResult<T>>> {
  const kind = readWriteRequestRunKind(run);

  switch (kind) {
    case "insert":
      return executor.insertRows(
        run.map((item) => {
          if (item.request.kind !== "insert") {
            throw new Error("Invalid insert batch run");
          }

          return item.request.row;
        }),
      );

    case "update":
      return executor.updateRows(
        run.map((item) => {
          if (item.request.kind !== "update") {
            throw new Error("Invalid update batch run");
          }

          return {
            id: item.request.id,
            updater: item.request.updater,
          };
        }),
      );

    case "delete":
      return executor.deleteRowsById(
        run.map((item) => {
          if (item.request.kind !== "delete") {
            throw new Error("Invalid delete batch run");
          }

          return item.request.id;
        }),
      );
  }
}

function readWriteRequestRunKind<T extends Record<string, unknown>>(
  run: WriteRequestRun<T>,
): WriteRequestKind {
  const kind = run[0]?.request.kind;

  if (kind === undefined) {
    throw new Error("Write batch run must not be empty");
  }

  return kind;
}

function createContiguousRuns<T extends Record<string, unknown>>(
  requests: Array<RepositoryWriteRequest<T>>,
): Array<WriteRequestRun<T>> {
  const runs: Array<WriteRequestRun<T>> = [];
  let currentRun: WriteRequestRun<T> = [];

  requests.forEach((request, index) => {
    const previousKind = currentRun[0]?.request.kind;

    if (previousKind !== undefined && previousKind !== request.kind) {
      runs.push(currentRun);
      currentRun = [];
    }

    currentRun.push({ index, request });
  });

  if (currentRun.length > 0) {
    runs.push(currentRun);
  }

  return runs;
}

function assignRunResults<T extends Record<string, unknown>>(
  results: Array<RepositoryWriteResult<T>>,
  run: WriteRequestRun<T>,
  runResults: Array<RepositoryWriteResult<T>>,
): void {
  if (run.length !== runResults.length) {
    throw new Error("Write batch result count must match input count");
  }

  run.forEach((item, index) => {
    results[item.index] = runResults[index];
  });
}
