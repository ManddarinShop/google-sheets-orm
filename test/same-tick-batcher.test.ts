import { describe, expect, it, vi } from "vitest";

import { createSameTickBatcher } from "../src/core/SameTickBatcher.js";

describe("createSameTickBatcher", () => {
  it("coalesces same-tick items into one ordered flush", async () => {
    const flush = vi.fn(async (items: string[]) =>
      items.map((item) => item.toUpperCase()),
    );
    const batcher = createSameTickBatcher<string, string>({ flush });

    await expect(
      Promise.all([batcher.enqueue("a"), batcher.enqueue("b")]),
    ).resolves.toEqual(["A", "B"]);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(["a", "b"]);
  });

  it("rejects every queued item when a batch flush fails", async () => {
    const error = new Error("flush failed");
    const batcher = createSameTickBatcher<string, string>({
      flush: async () => {
        throw error;
      },
    });

    const first = batcher.enqueue("a");
    const second = batcher.enqueue("b");

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
  });
});
