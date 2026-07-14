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

- `public/`: entity-oriented repository facade and public transaction contracts.
  Queue task details are hidden from this layer's public types.
- `transaction/`: collects entity mutations, serializes writes, and retains
  materialized batches for ambiguous enqueue recovery.
- `writer/`: validates canonical state, materializes immutable queue batches,
  and converts validated operations into durable task payloads.
- `processor/`: separate infrastructure API for draining pending queue
  transaction groups and summarizing processor results.

## `shared/`

- `RepositoryTypes.ts`: repository schema types shared by both write modes.
- `RepositoryRowHelpers.ts`: parsed row, duplicate-key, and serialization
  helpers shared by direct and queued write engines.

## Compatibility barrels

- `repository/index.ts`: re-exports both public repository facades and keeps the
  existing import path stable.
- `write/index.ts`: compatibility barrel for direct and queued write internals;
  these exports are not part of the root public API.

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
