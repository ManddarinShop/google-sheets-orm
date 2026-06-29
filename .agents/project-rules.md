# Agent Project Rules

## Project Identity

This project is `typed-sheets`: a TypeScript library for using Google Sheets as a lightweight typed data layer for MVPs, internal tools, prototypes, and low-traffic admin workflows.

Preferred positioning:

> Typed repository and safe write layer for Google Sheets-backed MVPs.

Longer-term direction:

> A lightweight SQL layer backed by Google Sheets, similar in spirit to an online H2-like experience for MVPs and internal tools.

## What This Project Is Not

Do not present the project as:

- a MySQL/Postgres replacement
- a transaction-safe database
- Prisma/JPA for Google Sheets
- a general-purpose Google Sheets API wrapper

Google Sheets remains a spreadsheet with weak transactional guarantees, API quota limits, and manual edit risk.

## Layering

Respect this layering:

```txt
SQL Layer               future
Repository/Core Layer   current safety layer
Adapter Layer           Google Sheets I/O
Google Sheets API       external service
```

The SQL layer must eventually call the repository/core layer. It must not bypass schema validation, parsing, duplicate key detection, or optimistic locking.

## Current Core Responsibilities

Core owns:

- schema validation
- duplicate header detection
- required/key/version column detection
- row parsing
- duplicate key detection
- `findAll`
- `findById`
- `insert`
- `update`
- `_version` optimistic locking
- `SchemaDriftError`
- `ParseError`
- `ConflictError`

## Adapter Responsibilities

Adapters own I/O only:

- authentication setup
- Google Sheets API calls
- range construction
- read sheet values
- append row
- update row

Adapters must not own:

- schema validation
- domain parsing
- duplicate key policy
- optimistic locking policy
- SQL interpretation

## Google Sheets Adapter Status

The Google Sheets adapter should support:

- `readSheet(sheetName)`
- `appendRow(sheetName, row)`
- `updateRow(sheetName, rowNumber, row)`

Unit tests should use fake injected Google Sheets clients.

Real Google API tests must be opt-in integration tests and must not run during default `npm test`.

## Authentication Direction

For local developer login, prefer Application Default Credentials:

```sh
gcloud auth application-default login
```

For server/CI, service account credentials are acceptable, but credentials must never be committed.

Integration tests should be able to skip cleanly when required environment variables or credentials are absent.

## Testing Policy

Default tests:

- fast
- deterministic
- no Google network calls
- no credentials
- fake adapters or fake Sheets clients

Integration tests:

- opt-in only
- require explicit command
- may use real Google Sheets
- must document required env variables

## Documentation Policy

README and PR bodies should mention limitations clearly:

- no joins yet
- no SQL execution yet
- no migrations
- no transactions
- no multi-row atomic updates
- no Apps Script gateway yet
- stale-write protection is not full transactional safety

## Agent Conduct For This Repo

When in doubt:

1. Prefer tests, docs, or explanation over production edits.
2. Do not edit `src/**` without explicit implementation permission.
3. Keep changes small.
4. Preserve the core/adapter/SQL layering.
5. Report exact commands run and test results.
