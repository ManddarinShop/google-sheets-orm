interface QueuedBatchItem<TItem, TResult> {
  item: TItem;
  resolve(value: TResult): void;
  reject(error: unknown): void;
}

export interface SameTickBatcher<TItem, TResult> {
  enqueue(item: TItem): Promise<TResult>;
}

export interface CreateSameTickBatcherInput<TItem, TResult> {
  flush(items: TItem[]): Promise<TResult[]>;
}

/**
 * Collects calls made in the same JavaScript tick and flushes them as one
 * ordered batch. Flushes run one at a time so a later batch cannot observe a
 * stale sheet snapshot while an earlier write is still in flight.
 */
export function createSameTickBatcher<TItem, TResult>(
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
