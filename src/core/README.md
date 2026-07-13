# Core module map

`src/core` is split into mode-specific internal packages. Public exports still
flow through `src/index.ts`; the legacy `repository/` and `write/` folders keep
compatibility barrels while the implementation lives under `direct/`,
`queued/`, and `shared/`.

## `direct/`

- `DirectSheetRepository.ts`: direct synchronous sheet repository. This is the
  legacy `createSheetRepository()` path and mutates the target sheet directly.
- `DirectRepositoryWriteBatcher.ts`: same-tick direct write batching.
- `DirectSheetWriteContext.ts`: direct adapter/write context.
- `DirectSheetWriteExecutor.ts`: direct write implementation with optimistic
  locking and adapter bulk paths.

## `queued/`

- `QueuedSheetWriteExecutor.ts`: queued write implementation for
  `QueuedSheetRepository.ts`. It reads the current canonical snapshot, validates
  requested changes, converts them into immutable queue batches, and appends
  tasks through `AppsScriptQueueAdapter`. It does not retain transaction or
  retry state.
- `QueuedRepositoryTransactionCoordinator.ts`: owns repository transaction
  serialization, retained materialized batches, and ambiguous enqueue retries
  around the low-level queue executor.
- `QueuedSheetRepository.ts`: queued repository facade and transaction scope.
- `QueuedWriteTaskProducer.ts`: low-level conversion from validated
  repository operations into durable task-queue payloads.

## `shared/`

- `RepositoryTypes.ts`: repository schema types shared by both write modes.
- `RepositoryRowHelpers.ts`: parsed row, duplicate-key, and serialization
  helpers shared by direct and queued write engines.

## Compatibility barrels

- `repository/index.ts`: re-exports both public repository facades and keeps the
  existing import path stable.
- `write/index.ts`: re-exports direct and queued write internals for tests and
  existing internal callers.

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

`ColumnMap` now lives in `shared/RepositoryTypes.ts` because both repository
modes need the same typed column contract. The old repository exports continue
to re-export it for source compatibility.
