/**
 * SQLite writer lease and fencing token management.
 *
 * Per design concurrency/writer-rpc.md:
 * - Single writer owns all canonical/outbox mutations.
 * - Every mutation CAS-checks the current fencing token.
 * - Lease takeover increments epoch + fencing token.
 * - Stale fencing tokens are rejected even if the affected row hasn't changed.
 */

import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";

export interface WriterLease {
  readonly role: string;
  readonly writerId: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly leaseUntil: number;
}

export interface ClaimLeaseOptions {
  readonly role: string;
  readonly writerId: string;
  readonly leaseDurationMs: number;
  readonly now: number;
}

/** The current lease identity required for a fenced storage mutation. */
export interface FencingContext {
  readonly role: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly now: number;
}

/**
 * Claims or renews the writer lease for a role.
 *
 * If no lease exists, creates one with epoch 1.
 * If the current lease belongs to this writer, renews it.
 * If the current lease has expired, takes over with incremented epoch + new fencing token.
 * If the current lease is held by another active writer, returns null (fail-closed).
 */
export function claimWriterLease(
  db: DatabaseSyncLike,
  options: ClaimLeaseOptions,
): WriterLease | null {
  validateClaimOptions(options);

  return withSavepoint(db, "claim_writer_lease", () => {
    const existing = db
      .prepare("SELECT role, writer_id, writer_epoch, fencing_token, lease_until FROM writer_lease WHERE role = ?")
      .get(options.role) as LeaseRow | undefined;
    const newLeaseUntil = options.now + options.leaseDurationMs;

    if (existing === undefined) {
      const lease = makeLease(options.role, options.writerId, 1, newLeaseUntil);
      const result = db.prepare(
        `INSERT INTO writer_lease (role, writer_id, writer_epoch, fencing_token, lease_until)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        lease.role,
        lease.writerId,
        lease.writerEpoch,
        lease.fencingToken,
        lease.leaseUntil,
      );
      return result.changes === 1 ? lease : null;
    }

    if (existing.writer_id === options.writerId && existing.lease_until > options.now) {
      const result = db.prepare(
        `UPDATE writer_lease
         SET lease_until = ?
         WHERE role = ? AND writer_id = ? AND writer_epoch = ?
           AND fencing_token = ? AND lease_until > ?`,
      ).run(
        newLeaseUntil,
        options.role,
        options.writerId,
        existing.writer_epoch,
        existing.fencing_token,
        options.now,
      );
      return result.changes === 1
        ? {
            role: existing.role,
            writerId: existing.writer_id,
            writerEpoch: existing.writer_epoch,
            fencingToken: existing.fencing_token,
            leaseUntil: newLeaseUntil,
          }
        : null;
    }

    if (existing.lease_until > options.now) {
      return null;
    }

    // An expired owner, including the same process, must take a new epoch.
    // Reusing its old fence would allow delayed work to look current again.
    const takeover = makeLease(
      options.role,
      options.writerId,
      existing.writer_epoch + 1,
      newLeaseUntil,
    );
    const result = db.prepare(
      `UPDATE writer_lease
       SET writer_id = ?, writer_epoch = ?, fencing_token = ?, lease_until = ?
       WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until <= ?`,
    ).run(
      takeover.writerId,
      takeover.writerEpoch,
      takeover.fencingToken,
      takeover.leaseUntil,
      options.role,
      existing.writer_epoch,
      existing.fencing_token,
      options.now,
    );
    return result.changes === 1 ? takeover : null;
  });
}

/** Reads the current lease for a role, or null if none exists. */
export function readWriterLease(db: DatabaseSyncLike, role: string): WriterLease | null {
  const row = db
    .prepare("SELECT role, writer_id, writer_epoch, fencing_token, lease_until FROM writer_lease WHERE role = ?")
    .get(role) as
    | { role: string; writer_id: string; writer_epoch: number; fencing_token: string; lease_until: number }
    | undefined;
  return row === undefined
    ? null
    : {
        role: row.role,
        writerId: row.writer_id,
        writerEpoch: row.writer_epoch,
        fencingToken: row.fencing_token,
        leaseUntil: row.lease_until,
      };
}

/**
 * Checks whether the given epoch + fencing token match the current lease.
 * Used by effect workers to verify their claim is still valid before applying results.
 */
export function isFencingValid(db: DatabaseSyncLike, fence: FencingContext): boolean {
  const lease = readWriterLease(db, fence.role);
  if (lease === null) return false;
  return (
    lease.writerEpoch === fence.writerEpoch &&
    lease.fencingToken === fence.fencingToken &&
    lease.leaseUntil > fence.now
  );
}

interface LeaseRow {
  readonly role: string;
  readonly writer_id: string;
  readonly writer_epoch: number;
  readonly fencing_token: string;
  readonly lease_until: number;
}

function makeLease(
  role: string,
  writerId: string,
  writerEpoch: number,
  leaseUntil: number,
): WriterLease {
  return {
    role,
    writerId,
    writerEpoch,
    fencingToken: `fence-${writerEpoch}`,
    leaseUntil,
  };
}

function validateClaimOptions(options: ClaimLeaseOptions): void {
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new Error("writer lease now must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
    throw new Error("writer lease duration must be a positive safe integer");
  }
  if (options.role.length === 0 || options.writerId.length === 0) {
    throw new Error("writer lease role and writer ID are required");
  }
}

function withSavepoint<T>(
  db: DatabaseSyncLike,
  name: string,
  operation: () => T,
): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = operation();
    db.exec(`RELEASE ${name}`);
    return value;
  } catch (error: unknown) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
