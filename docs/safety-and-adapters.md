# Safety and Adapters

`typed-sheets` is a typed repository and safe write layer for Google
Sheets-backed MVPs. It is not a MySQL/Postgres replacement, a full ORM, or a
general-purpose Google Sheets API wrapper.

## Sheet Shape

The first row is treated as the header row.

Example `Users` sheet:

| id | email | age | active | _version |
| --- | --- | --- | --- | --- |
| u1 | a@test.com | 20 | true | 1 |
| u2 | b@test.com |  | false | 1 |

`typed-sheets` maps cells by header order, not by hard-coded column position.

## Adapter Boundary

`typed-sheets` core does not directly depend on Google SDKs.

Adapters provide sheet-level operations:

```ts
export type SheetCell = string | number | boolean | null;

export interface SheetSnapshot {
  headers: string[];
  rows: SheetRowSnapshot[];
}

export interface SheetRowSnapshot {
  rowNumber: number;
  cells: SheetCell[];
}

export interface SheetAdapter {
  readSheet(sheetName: string): Promise<SheetSnapshot>;
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  updateRow(sheetName: string, rowNumber: number, row: SheetCell[]): Promise<void>;
  deleteRow(sheetName: string, rowNumber: number): Promise<void>;
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
  initializeSheet?(sheetName: string, headers: string[]): Promise<void>;
}
```

The adapter owns authentication, Google API calls, range mapping, append, row
update mechanics, and optional sheet initialization.

The core owns schema validation, parsing, duplicate key detection, repository
methods, and optimistic locking.

## Google Sheets Adapter

`GoogleSheetsAdapter` connects the repository core to the Google Sheets API.

```ts
import { GoogleSheetsAdapter } from "typed-sheets";

const adapter = new GoogleSheetsAdapter({
  spreadsheetUrl: process.env.GOOGLE_SPREADSHEET_URL!,
  auth,
});
```

The adapter currently implements:

- `ensureSheet(sheetName)`
- `writeHeader(sheetName, headers)`
- `readSheet(sheetName)`
- `appendRow(sheetName, row)`
- `updateRow(sheetName, rowNumber, row)`
- `deleteRow(sheetName, rowNumber)`

`ensureSheet` creates a missing sheet tab. Repository-level `ensureSheet()`
writes schema headers only when the header row is empty. If headers already
exist, it checks schema drift and does not auto-rewrite them.

It uses raw values where possible:

- `readSheet` uses `valueRenderOption: "UNFORMATTED_VALUE"`
- `appendRow` and `updateRow` use `valueInputOption: "RAW"`

## Schema Drift

Schema drift fails with `SchemaDriftError`.

Detected cases:

- duplicate headers
- missing declared columns
- missing key column
- missing `_version` column
- duplicate keys

Extra sheet columns are allowed by default. They are ignored when parsing typed
rows, and currently serialized as omitted values unless represented by declared
columns.

## Parse Errors

Invalid row values fail with `ParseError`.

Examples:

- missing required value
- invalid number
- invalid boolean

## Optimistic Locking

`update(id, updater)` uses `_version` for stale write protection.

The update flow:

1. Read current sheet.
2. Parse the target row.
3. Keep the current `_version`.
4. Apply the updater.
5. Re-read the sheet before writing.
6. If `_version` changed, throw `ConflictError`.
7. Otherwise write the row with `_version + 1`.

This is stale-write protection, not a full database transaction.

`deleteById(id)` follows the same safety model. It returns the deleted row when
the key exists, returns `null` when no row matches the key, and throws
`ConflictError` when the target row moved or its `_version` changed before the
delete is sent to the adapter.

Deletes remove the physical Google Sheets row. Rows below the deleted row shift
up, so application code should treat sheet row numbers as adapter internals and
use repository keys for follow-up operations.

## Current Limitations

This project currently does not support:

- joins
- relations
- SQL execution
- migrations
- transactions
- multi-row atomic updates
- cache or request collapse
- retry/backoff
- browser support
- automatic Apps Script gateway installation

## Long-Term Direction

The long-term direction is a lightweight SQL layer backed by Google Sheets,
closer to an online H2-like database experience for MVPs and internal tools.

Concurrency control and transaction semantics are later-stage work. The first
priority is a typed table/storage model that can safely support repository
operations and eventually a small SQL subset.
