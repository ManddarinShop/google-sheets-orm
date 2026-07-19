import type { RepositorySnapshot } from "../writer/QueuedSheetWriteExecutor.js";

export interface QueuedRepositoryReadCacheOptions {
  /** Enables the repository-local confirmed canonical snapshot cache. */
  enabled?: boolean;
  /** Maximum age of a cached snapshot in milliseconds. `0` disables reuse. */
  ttlMs?: number;
}

export interface QueuedRepositoryReadCache<T extends object> {
  get(): RepositorySnapshot<T> | null;
  set(snapshot: RepositorySnapshot<T>): void;
  invalidate(): void;
}

const DEFAULT_CACHE_TTL_MS = 5_000;

/**
 * Creates a small repository-local cache for confirmed canonical snapshots.
 * Queued payloads are never inserted into this cache; writes invalidate it so
 * a later read refreshes from the canonical sheet.
 */
export function createQueuedRepositoryReadCache<T extends object>(
  options: QueuedRepositoryReadCacheOptions = {},
): QueuedRepositoryReadCache<T> {
  const enabled = options.enabled ?? true;
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;

  assertCacheTtl(ttlMs);

  let entry: {
    snapshot: RepositorySnapshot<T>;
    expiresAtMs: number;
  } | null = null;

  function get(): RepositorySnapshot<T> | null {
    if (!enabled || ttlMs === 0 || entry === null) {
      return null;
    }

    if (Date.now() >= entry.expiresAtMs) {
      entry = null;
      return null;
    }

    return cloneSnapshot(entry.snapshot);
  }

  function set(snapshot: RepositorySnapshot<T>): void {
    if (!enabled || ttlMs === 0) {
      return;
    }

    entry = {
      snapshot: cloneSnapshot(snapshot),
      expiresAtMs: Date.now() + ttlMs,
    };
  }

  function invalidate(): void {
    entry = null;
  }

  return { get, set, invalidate };
}

function assertCacheTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new RangeError(
      "Queued repository cache ttlMs must be a non-negative integer",
    );
  }
}

function cloneSnapshot<T extends object>(
  snapshot: RepositorySnapshot<T>,
): RepositorySnapshot<T> {
  return {
    headers: [...snapshot.headers],
    parsedRows: snapshot.parsedRows.map((parsedRow) => ({
      rowNumber: parsedRow.rowNumber,
      cells: [...parsedRow.cells],
      row: { ...parsedRow.row },
    })),
  };
}
