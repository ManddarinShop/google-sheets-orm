import type { RepositoryWriteContext } from "../write/DirectSheetWriteContext.js";
import {
  createRepositorySyncWriteExecutor,
  type RepositorySyncWriteExecutor,
} from "../write/DirectSheetWriteExecutor.js";

type RepositoryWriteRequest<T extends Record<string, unknown>> =
  | {
      kind: "insert";
      row: T;
    }
  | {
      kind: "update";
      id: string;
      updater(current: T): T;
    }
  | {
      kind: "delete";
      id: string;
    };

type RepositoryWriteResult<T extends Record<string, unknown>> = void | T | null;

interface IndexedWriteRequest<T extends Record<string, unknown>> {
  index: number;
  request: RepositoryWriteRequest<T>;
}

type WriteRequestRun<T extends Record<string, unknown>> = Array<
  IndexedWriteRequest<T>
>;

export interface RepositoryWriteBatcher<T extends Record<string, unknown>> {
  insert(row: T): Promise<void>;
  update(id: string, updater: (current: T) => T): Promise<T | null>;
  deleteById(id: string): Promise<T | null>;
}

/**
 * Batches same-tick direct repository writes while preserving mixed-operation
 * order. Contiguous operations of the same kind use the executor's bulk path.
 */
export function createRepositoryWriteBatcher<
  T extends Record<string, unknown>,
>(input: RepositoryWriteContext<T>): RepositoryWriteBatcher<T> {
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

interface QueuedBatchItem<TItem, TResult> {
  item: TItem;
  resolve(value: TResult): void;
  reject(error: unknown): void;
}

interface SameTickBatcher<TItem, TResult> {
  enqueue(item: TItem): Promise<TResult>;
}

interface CreateSameTickBatcherInput<TItem, TResult> {
  flush(items: Array<TItem>): Promise<Array<TResult>>;
}

/**
 * Collects calls made in one JavaScript tick and serializes subsequent batches
 * so a later read cannot observe a stale snapshot from an earlier write.
 */
function createSameTickBatcher<TItem, TResult>(
  input: CreateSameTickBatcherInput<TItem, TResult>,
): SameTickBatcher<TItem, TResult> {
  let queuedItems: Array<QueuedBatchItem<TItem, TResult>> = [];
  let flushScheduled = false;
  let flushRunning = false;

  return {
    enqueue(item) {
      return new Promise<TResult>((resolve, reject) => {
        queuedItems.push({ item, resolve, reject });
        scheduleFlush();
      });
    },
  };

  function scheduleFlush(): void {
    if (flushScheduled || flushRunning) {
      return;
    }

    flushScheduled = true;
    queueMicrotask(flush);
  }

  async function flush(): Promise<void> {
    const batch = queuedItems;

    queuedItems = [];
    flushScheduled = false;
    flushRunning = true;

    try {
      const results = await input.flush(
        batch.map((queuedItem) => queuedItem.item),
      );

      if (results.length !== batch.length) {
        throw new Error("Batch flush result count must match input count");
      }

      batch.forEach((queuedItem, index) => {
        queuedItem.resolve(results[index] as TResult);
      });
    } catch (error) {
      for (const queuedItem of batch) {
        queuedItem.reject(error);
      }
    } finally {
      flushRunning = false;

      if (queuedItems.length > 0) {
        scheduleFlush();
      }
    }
  }
}

async function flushWriteRequests<T extends Record<string, unknown>>(
  executor: RepositorySyncWriteExecutor<T>,
  requests: Array<RepositoryWriteRequest<T>>,
): Promise<Array<RepositoryWriteResult<T>>> {
  const results = new Array<RepositoryWriteResult<T>>(requests.length);

  for (const run of createContiguousRuns(requests)) {
    const runResults = await executeWriteRequestRun(executor, run);

    if (run.length !== runResults.length) {
      throw new Error("Write batch result count must match input count");
    }

    run.forEach((item, index) => {
      results[item.index] = runResults[index];
    });
  }

  return results;
}

async function executeWriteRequestRun<T extends Record<string, unknown>>(
  executor: RepositorySyncWriteExecutor<T>,
  run: WriteRequestRun<T>,
): Promise<Array<RepositoryWriteResult<T>>> {
  const kind = run[0]?.request.kind;

  if (kind === undefined) {
    throw new Error("Write batch run must not be empty");
  }

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
      return executor.updateRowsById(
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
