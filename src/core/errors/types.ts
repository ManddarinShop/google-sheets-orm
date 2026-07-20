/** Structured error value shared by pure core decisions. */
export interface CoreError {
  /** Stable domain namespace used by callers instead of parsing messages. */
  readonly domain: string;
  /** Stable machine-readable error code. */
  readonly code: string;
}
