# typed-sheets

Typed repository and safe write layer for Google Sheets-backed MVPs.

`typed-sheets` is a TypeScript library for using Google Sheets as a lightweight, editable data store for early MVPs, internal tools, prototypes, and low-traffic admin workflows.

It is not a MySQL/Postgres replacement, not a full ORM, and not a general-purpose Google Sheets API wrapper. The core goal is to make unsafe spreadsheet-backed data states fail clearly instead of passing silently.

## Current MVP

The current MVP focuses on repository safety:

- schema drift validation
- typed row parsing
- key-based `findAll` and `findById`
- `insert`
- `update`
- `deleteById`
- `_version` based optimistic locking
- `SchemaDriftError`
- `ParseError`
- `ConflictError`
- adapter boundary for Google Sheets access

## Installation

For local development:

```sh
npm install
npm test
npm run typecheck
npm run build
```

## Quick Start

Create a local config first. After the package is published, run:

```sh
npx typed-sheets setup
```

For local development, run the CLI from a linked package or add a temporary
package script that points at `dist/cli/Cli.js` after `npm run build`.

The setup command writes `.typed-sheets.json`. Choose one connection path:

- service account: best for servers, CI, and deployed apps that can use a
  Google Cloud service account
- Apps Script gateway: best when the spreadsheet owner wants to connect without
  a service account or Google Cloud setup

Example service-account config:

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/your-spreadsheet-id/edit",
  "defaultSheetName": "Users",
  "auth": {
    "type": "service-account",
    "credentialsFile": "/absolute/path/to/service-account.json"
  }
}
```

Example Apps Script gateway config:

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/your-spreadsheet-id/edit",
  "defaultSheetName": "Users",
  "auth": {
    "type": "apps-script-gateway",
    "gatewayUrl": "https://script.google.com/macros/s/your-deployment-id/exec",
    "gatewaySecret": "your-gateway-secret"
  }
}
```

For the Apps Script gateway path, deploy the shipped `Code.gs` script as a Web
App before using the generated config. See the manual gateway guide in
[`templates/manual-apps-script-gateway/README.md`](templates/manual-apps-script-gateway/README.md).

Then create repositories from that config:

```ts
import {
  boolean,
  createRepositoryFromConfig,
  number,
  text,
} from "typed-sheets";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

const users = await createRepositoryFromConfig<User>({
  key: "id",
  columns: {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  },
});

await users.ensureSheet();

const allUsers = await users.findAll();
const user = await users.findById("u1");

await users.insert({
  id: "u2",
  email: "b@test.com",
  age: undefined,
  active: true,
  _version: 1,
});

const updated = await users.update("u2", current => ({
  ...current,
  age: 30,
}));

await users.deleteById("u2");
```

`ensureSheet()` creates the configured sheet tab when it is missing and writes
the schema header only when the header row is empty. Existing headers are
validated, not automatically rewritten.

## Config-Based Runtime

After running `typed-sheets setup`, `createRepositoryFromConfig()` reads
`.typed-sheets.json` from the current working directory by default. Pass `cwd`
or `configPath` to point at a different config file.

```ts
const users = await createRepositoryFromConfig<User>({
  cwd: "/app",
  configPath: "/app/.typed-sheets.json",
  key: "id",
  columns,
});
```

Service account configs create a `GoogleSheetsAdapter` and call the Google
Sheets API directly. The target Sheet must be shared with the service account
`client_email`.

Apps Script gateway configs create an `AppsScriptGatewayAdapter` and send
repository operations to the deployed Web App with `gatewayUrl` and
`gatewaySecret`. The gateway script must be the `Code.gs` generated or shipped
with the same package version.

## Advanced Direct Adapter Usage

Use direct adapter construction when you want to manage authentication and
adapter wiring yourself instead of loading `.typed-sheets.json`.

```ts
import {
  GoogleSheetsAdapter,
  boolean,
  createSheetRepository,
  number,
  text,
} from "typed-sheets";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

const adapter = new GoogleSheetsAdapter({
  spreadsheetUrl: process.env.GOOGLE_SPREADSHEET_URL!,
});

const users = createSheetRepository<User>({
  adapter,
  sheetName: "Users",
  key: "id",
  columns: {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  },
});
```

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

The adapter owns authentication, Google API calls, range mapping, append, row update mechanics, and optional sheet initialization.

The core owns schema validation, parsing, duplicate key detection, repository methods, and optimistic locking.

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

`ensureSheet` creates a missing sheet tab. Repository-level `ensureSheet()` writes schema headers only when the header row is empty. If headers already exist, it checks schema drift and does not auto-rewrite them.

It uses raw values where possible:

- `readSheet` uses `valueRenderOption: "UNFORMATTED_VALUE"`
- `appendRow` and `updateRow` use `valueInputOption: "RAW"`

## Safety Policies

### Schema Drift

Schema drift fails with `SchemaDriftError`.

Detected cases:

- duplicate headers
- missing declared columns
- missing key column
- missing `_version` column
- duplicate keys

Extra sheet columns are allowed by default. They are ignored when parsing typed rows, and currently serialized as omitted values unless represented by declared columns.

### Parse Errors

Invalid row values fail with `ParseError`.

Examples:

- missing required value
- invalid number
- invalid boolean

### Optimistic Locking

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

The long-term direction is a lightweight SQL layer backed by Google Sheets, closer to an online H2-like database experience for MVPs and internal tools.

Concurrency control and transaction semantics are later-stage work. The first priority is a typed table/storage model that can safely support repository operations and eventually a small SQL subset.

Before the SQL layer, the next priority is a setup layer that improves first-run accessibility:

- install the library
- run a setup command
- choose service account or manual Apps Script gateway setup
- paste or enter the required Google Sheets connection details
- write a local JSON configuration file for the application to use

The setup layer should make the first successful connection easier without changing the repository safety model.

## Development

```sh
npm test
npm run test:integration
npm run typecheck
npm run build
```

Current test coverage focuses on:

- column parsing
- schema validation
- row parsing
- repository reads
- insert behavior
- update behavior
- public API exports

## Integration Smoke Test

Google Sheets integration tests are opt-in. They are not part of the default `npm test` command because they require credentials, spreadsheet access, and Google API quota.

The smoke test writes a temporary `.typed-sheets.json`, creates repositories with `createRepositoryFromConfig()`, then inserts, reads, lists, updates, and deletes timestamp-based rows.

Both config paths are supported:

- service-account direct Google Sheets API access
- Apps Script gateway access

The smoke test calls repository-level `ensureSheet()` before CRUD. If the configured sheet tab is missing, the adapter creates it. If the header row is empty, the repository writes this schema header. Apps Script gateway configs perform sheet creation and header initialization in one locked gateway operation.

| id | email | age | active | _version |
| --- | --- | --- | --- | --- |

If headers already exist, the test does not rewrite them. Schema drift still fails.

For service-account authentication:

1. Create or choose a Google Cloud service account.
2. Download its JSON key.
3. Share the target spreadsheet with the service account email.
4. Run:

```sh
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
GOOGLE_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/your-spreadsheet-id/edit \
GOOGLE_SHEET_NAME=Users \
npm run test:integration
```

For Apps Script gateway authentication, deploy the gateway script and add the
secret to `.env`:

```sh
GOOGLE_APPS_SCRIPT_GATEWAY_SECRET=your-gateway-secret
```

Then run:

```sh
GOOGLE_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/your-spreadsheet-id/edit \
GOOGLE_APPS_SCRIPT_GATEWAY_URL=https://script.google.com/macros/s/your-deployment-id/exec \
GOOGLE_APPS_SCRIPT_GATEWAY_SHEET_NAME=Users \
npm run test:integration
```

You can also put these values in `.env`; `npm run test:integration` loads `.env` automatically when it exists. `GOOGLE_SERVICE_ACCOUNT_SHEET_NAME` and `GOOGLE_APPS_SCRIPT_GATEWAY_SHEET_NAME` can be used to target different sheets; both fall back to `GOOGLE_SHEET_NAME` and then `Users`.

If you are starting from `typed-sheets setup`, deploy the gateway script, reload
the Google Sheet, click `typed-sheets > Setup gateway` or run
`setupTypedSheets()`, and paste the execution-log output into the setup editor
prompt. On macOS, copy the gateway script without selecting terminal output:

```sh
pbcopy < templates/manual-apps-script-gateway/Code.gs
```

The CLI extracts the config JSON before writing `.typed-sheets.json`.

When a smoke path is skipped, the test name includes the missing environment
variables. For example, the Apps Script gateway smoke test requires
`GOOGLE_SPREADSHEET_URL`, `GOOGLE_APPS_SCRIPT_GATEWAY_URL`, and
`GOOGLE_APPS_SCRIPT_GATEWAY_SECRET`.

The shipped setup flow points users to the manual Apps Script gateway templates
under `templates/manual-apps-script-gateway/`. Keep those files in the package
`files` list when changing the setup flow.
