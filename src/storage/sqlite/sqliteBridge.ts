/**
 * SQLite driver bridge for `node:sqlite` that vitest/vite-node can resolve.
 *
 * vite-node does not yet recognize `node:sqlite` as a built-in module. Loading
 * it through Node's `createRequire` leaves the specifier to the runtime while
 * keeping the storage type boundary independent from its declaration files.
 */

import { createRequire } from "node:module";

interface DatabaseSyncOpenOptions {
  readonly readOnly?: boolean;
}

type DatabaseSyncConstructor = new (path: string, options?: DatabaseSyncOpenOptions) => DatabaseSyncLike;

let cached: DatabaseSyncConstructor | null = null;

// EntityStore writes can be composed inside a writer RPC that already owns an
// immediate transaction. SQLite does not allow a nested BEGIN, so track the
// outer scope and use a savepoint for nested calls.
const transactionDepth = new WeakMap<DatabaseSyncLike, number>();
let savepointSequence = 0;

// Keep the specifier outside a statically analyzable import so vite-node leaves
// Node's experimental/built-in sqlite module untouched.
const nodeSqliteSpecifier: string = "node:sqlite";
const requireAtRuntime = createRequire(import.meta.url);

export async function openDatabase(path: string): Promise<DatabaseSyncLike> {
  const DatabaseSync = await getDatabaseSync();
  return new DatabaseSync(path);
}

/** Opens an existing SQLite backup without granting this process write access. */
export async function openReadOnlyDatabase(path: string): Promise<DatabaseSyncLike> {
  const DatabaseSync = await getDatabaseSync();
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Runs one outer writer transaction with SQLite's immediate write reservation.
 *
 * Call this only at a writer-RPC boundary, never from code that is already in a
 * transaction. Nested storage helpers use savepoints so a failed substep rolls
 * back without exposing a partial canonical or outbox mutation.
 */
export function withImmediateTransaction<T>(db: DatabaseSyncLike, operation: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth > 0) {
    const savepoint = `typed_sheets_nested_${++savepointSequence}`;
    try {
      transactionDepth.set(db, depth + 1);
      db.exec(`SAVEPOINT ${savepoint}`);
      const value = operation();
      db.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error: unknown) {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch {
        // Preserve the original error; a failed savepoint cleanup only adds
        // diagnostic noise to the writer failure.
      }
      throw error;
    } finally {
      transactionDepth.set(db, depth);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  transactionDepth.set(db, 1);
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error; a failed rollback only adds diagnostic noise.
    }
    throw error;
  } finally {
    transactionDepth.delete(db);
  }
}

/** Lazy-loaded DatabaseSync constructor. */
export async function getDatabaseSync(): Promise<
  DatabaseSyncConstructor
> {
  if (cached !== null) {
    return cached;
  }

  const mod: unknown = requireAtRuntime(nodeSqliteSpecifier);
  if (!hasDatabaseSyncConstructor(mod)) {
    throw new Error(
      "SQLite-authoritative storage requires a Node.js runtime that provides node:sqlite.",
    );
  }

  cached = mod.DatabaseSync;
  return cached;
}

/**
 * Minimal type description of DatabaseSync that the storage layer and tests
 * use. This avoids importing the real type from `node:sqlite` at the type
 * level, which would also trigger vite-node resolution.
 */
export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

export interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function hasDatabaseSyncConstructor(value: unknown): value is {
  readonly DatabaseSync: DatabaseSyncConstructor;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "DatabaseSync" in value &&
    typeof (value as { readonly DatabaseSync: unknown }).DatabaseSync === "function"
  );
}
