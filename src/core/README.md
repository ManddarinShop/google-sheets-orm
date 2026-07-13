# Core module map

`src/core` is split into small internal packages. Public exports still flow
through `src/index.ts`; these folders describe internal ownership boundaries.

## `repository/`

- `DirectSheetRepository.ts`: direct synchronous sheet repository. This is the
  legacy `createSheetRepository()` path and mutates the target sheet directly.
- `QueuedSheetRepository.ts`: queued repository facade. This is the task-queue
  path and exposes transaction-style `save()` / `remove()` workflows while
  delegating task creation to the queue write engine.
- `RepositoryRowHelpers.ts`: parsed repository row helpers shared by direct and
  queued write engines.
- `index.ts`: package exports for repository facades and repository-facing
  types.

## `write/`

- `DirectSheetWriteExecutor.ts`: direct write implementation for
  `DirectSheetRepository.ts`. It reads the sheet, checks schema/key/version
  state, then writes rows through `DirectSheetAdapter`.
- `QueuedSheetWriteExecutor.ts`: queued write implementation for
  `QueuedSheetRepository.ts`. It reads the current sheet snapshot, validates
  requested changes, converts them into queue operations, and appends task rows
  through `AppsScriptQueueAdapter`. Flushed queued writes are not visible to
  repository reads until the Apps Script queue processor applies them.
- `QueuedWriteTaskProducer.ts`: low-level conversion from validated
  repository operations into durable task-queue payloads.
- `index.ts`: package exports for write-engine tests and repository facades.

## `schema/`

- `Columns.ts`: built-in column definitions and parser/serializer contracts.
- `SheetSchema.ts`: sheet header validation and schema drift checks.
- `RowParser.ts`: converts raw sheet cells into typed entity objects.
- `index.ts`: package exports for column/schema/parser contracts.

## `errors/`

- `CoreErrors.ts`: typed repository errors.
- `index.ts`: package exports for public and internal error imports.

## Dependency direction

Repository facades call write engines. Write engines call shared row/schema
helpers. Schema and errors must not depend on repositories or write engines.

`ColumnMap` is still declared on the repository side: the direct repository
exports `ColumnMap`, the queued repository declares `QueuedColumnMap`, and the
queued write executor currently reuses the direct repository type. Move that
schema contract into `schema/` only as a separate code change.
