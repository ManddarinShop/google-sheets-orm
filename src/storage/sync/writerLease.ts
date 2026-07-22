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
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";

const READ_WRITER_LEASE_SQL =
  "SELECT role, writer_id, writer_epoch, fencing_token, lease_until FROM writer_lease WHERE role = ?";

const INSERT_WRITER_LEASE_SQL = `
  INSERT INTO writer_lease (role, writer_id, writer_epoch, fencing_token, lease_until)
  VALUES (?, ?, ?, ?, ?)
`;

const RENEW_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET lease_until = ?
  WHERE role = ? AND writer_id = ? AND writer_epoch = ?
    AND fencing_token = ? AND lease_until > ?
`;

const TAKEOVER_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET writer_id = ?, writer_epoch = ?, fencing_token = ?, lease_until = ?
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until <= ?
`;

export interface WriterLease {
  readonly role: string;
  readonly writerId: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly leaseUntil: number;
}

export type WriterLeaseClaimFailureReason =
  | "active_writer"
  | "initial_claim_not_applied"
  | "renewal_race_lost"
  | "takeover_race_lost";

export type WriterLeaseClaimResult =
  | { readonly kind: "claimed"; readonly lease: WriterLease }
  | {
      readonly kind: "not_claimed";
      readonly reason: WriterLeaseClaimFailureReason;
    };

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
 * If the current lease is held by another active writer, returns a typed failure.
 */
export function claimWriterLease(
  db: DatabaseSyncLike,
  options: ClaimLeaseOptions,
): WriterLeaseClaimResult {
  validateClaimOptions(options);

  return withSavepoint(db, "claim_writer_lease", () => {
    const existing = readLeaseRow(db, options.role);
    const newLeaseUntil = options.now + options.leaseDurationMs;

    if (existing === undefined) {
      const lease = makeLease(options.role, options.writerId, 1, newLeaseUntil);
      const result = db.prepare(INSERT_WRITER_LEASE_SQL).run(
        lease.role,
        lease.writerId,
        lease.writerEpoch,
        lease.fencingToken,
        lease.leaseUntil,
      );
      return result.changes === 1
        ? { kind: "claimed", lease }
        : { kind: "not_claimed", reason: "initial_claim_not_applied" };
    }

    if (existing.writer_id === options.writerId && existing.lease_until > options.now) {
      const result = db.prepare(RENEW_WRITER_LEASE_SQL).run(
        newLeaseUntil,
        options.role,
        options.writerId,
        existing.writer_epoch,
        existing.fencing_token,
        options.now,
      );
      return result.changes === 1
        ? {
            kind: "claimed",
            lease: {
              role: existing.role,
              writerId: existing.writer_id,
              writerEpoch: existing.writer_epoch,
              fencingToken: existing.fencing_token,
              leaseUntil: newLeaseUntil,
            },
          }
        : { kind: "not_claimed", reason: "renewal_race_lost" };
    }

    if (existing.lease_until > options.now) {
      return { kind: "not_claimed", reason: "active_writer" };
    }

    // An expired owner, including the same process, must take a new epoch.
    // Reusing its old fence would allow delayed work to look current again.
    const takeover = makeLease(
      options.role,
      options.writerId,
      existing.writer_epoch + 1,
      newLeaseUntil,
    );
    const result = db.prepare(TAKEOVER_WRITER_LEASE_SQL).run(
      takeover.writerId,
      takeover.writerEpoch,
      takeover.fencingToken,
      takeover.leaseUntil,
      options.role,
      existing.writer_epoch,
      existing.fencing_token,
      options.now,
    );
    return result.changes === 1
      ? { kind: "claimed", lease: takeover }
      : { kind: "not_claimed", reason: "takeover_race_lost" };
  });
}

/** Reads the current lease for a role, or null if none exists. */
export function readWriterLease(db: DatabaseSyncLike, role: string): WriterLease | null {
  const row = readLeaseRow(db, role);
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

function readLeaseRow(db: DatabaseSyncLike, role: string): LeaseRow | undefined {
  return db.prepare(READ_WRITER_LEASE_SQL).get(role) as LeaseRow | undefined;
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
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease now must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease duration must be a positive safe integer",
    );
  }
  if (options.role.length === 0 || options.writerId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease role and writer ID are required",
    );
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
