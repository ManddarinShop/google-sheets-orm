export interface RepositoryUpdateRequest<T extends Record<string, unknown>> {
  id: string;
  updater(current: T): T;
}

/**
 * Internal repository write engine contract. Direct sheet writes and queued
 * writes both implement this shape so repository methods can keep one public
 * API while the backing write strategy changes.
 */
export interface RepositoryWriteExecutor<T extends Record<string, unknown>> {
  insertRows(rows: Array<T>): Promise<Array<void>>;
  updateRowsById(
    requests: Array<RepositoryUpdateRequest<T>>,
  ): Promise<Array<T | null>>;
  deleteRowsById(ids: Array<string>): Promise<Array<T | null>>;
}
