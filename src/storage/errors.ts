/** Stable error categories shared by the storage layer. */
export const STORAGE_ERROR_CODES = {
  INVALID_WRITER_LEASE_OPTIONS: "invalid_writer_lease_options",
  SQLITE_RUNTIME_UNAVAILABLE: "sqlite_runtime_unavailable",
  SCHEMA_VERSION_TOO_NEW: "schema_version_too_new",
  SCHEMA_TABLE_MISSING: "schema_table_missing",
  SCHEMA_INDEX_MISSING: "schema_index_missing",
  SCHEMA_COLUMN_MISSING: "schema_column_missing",
  SCHEMA_VERSION_INVALID: "schema_version_invalid",
} as const;

export type StorageErrorCode =
  (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

/** Error raised when storage input, schema, or runtime prerequisites are invalid. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}
