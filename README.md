# typed-sheets

Typed repository and safe write layer for Google Sheets-backed MVPs.

`typed-sheets` lets TypeScript apps use Google Sheets as a lightweight,
editable repository for MVPs, internal tools, prototypes, and low-traffic admin
workflows.

It is not a MySQL/Postgres replacement, a full ORM, or a general-purpose Google
Sheets API wrapper. The goal is to make unsafe spreadsheet-backed data states
fail clearly instead of passing silently.

## Features

- schema drift validation
- typed row parsing
- key-based `findAll` and `findById`
- `insert`, `update`, and `deleteById`
- `_version` based optimistic locking
- `SchemaDriftError`, `ParseError`, and `ConflictError`
- service-account and Apps Script gateway adapters
- explicit queued repository transactions with stable retry identities
- config-based repository creation with `typed-sheets setup`

## Installation

```sh
npm install typed-sheets
```

## Quick Start

Create a local config first:

```sh
npx typed-sheets setup
```

The setup command writes `.typed-sheets.json`. Choose one connection path:

- service account: best for servers, CI, and deployed apps that can use a
  Google Cloud service account
- Apps Script gateway: best when the spreadsheet owner wants to connect without
  a service account or Google Cloud setup

For the Apps Script gateway path, deploy the shipped `Code.gs` script as a Web
App before using the generated config. See
[`templates/manual-apps-script-gateway/README.md`](templates/manual-apps-script-gateway/README.md).

## Usage

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

await users.insert({
  id: "u1",
  email: "a@test.com",
  age: 20,
  active: true,
  _version: 1,
});

const allUsers = await users.findAll();
const user = await users.findById("u1");

const updated = await users.update("u1", current => ({
  ...current,
  age: 21,
}));

await users.deleteById("u1");
```

`ensureSheet()` creates the configured sheet tab when it is missing and writes
the schema header only when the header row is empty. Existing headers are
validated, not automatically rewritten.

## Configuration

`typed-sheets setup` writes one of these config shapes. You usually do not need
to hand-write them.

Service account config:

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

Apps Script gateway config:

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

For the Apps Script gateway path, `gatewayUrl` is the deployed Web App URL that
ends with `/exec`. The setup flow asks you to paste that URL after deployment
and then writes it into `.typed-sheets.json`.

`createRepositoryFromConfig()` reads `.typed-sheets.json` from the current
working directory by default. Pass `cwd` or `configPath` to point at another
config file.

```ts
const users = await createRepositoryFromConfig<User>({
  cwd: "/app",
  configPath: "/app/.typed-sheets.json",
  key: "id",
  columns,
});
```

## API

```ts
interface SheetRepository<T> {
  ensureSheet(): Promise<void>;
  findAll(): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  insert(row: T): Promise<void>;
  update(id: string, updater: (current: T) => T): Promise<T | null>;
  deleteById(id: string): Promise<T | null>;
}
```

Direct adapter construction is also supported when you want to manage
authentication and adapter wiring yourself.

```ts
import {
  GoogleSheetsAdapter,
  boolean,
  createSheetRepository,
  number,
  text,
} from "typed-sheets";

const adapter = new GoogleSheetsAdapter({
  spreadsheetUrl: process.env.GOOGLE_SPREADSHEET_URL!,
  auth,
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

### Queued repository

Use the queued repository with the Apps Script gateway when writes should be
appended as durable tasks and processed explicitly:

```ts
import {
  AppsScriptGatewayAdapter,
  createQueuedRepositoryQueueProcessor,
  createQueuedSheetRepository,
  number,
  text,
} from "typed-sheets";

const adapter = new AppsScriptGatewayAdapter({
  gatewayUrl: process.env.TYPED_SHEETS_GATEWAY_URL!,
  gatewaySecret: process.env.TYPED_SHEETS_GATEWAY_SECRET!,
});

const orders = createQueuedSheetRepository({
  adapter,
  sheetName: "Orders",
  key: "id",
  columns: {
    id: text(),
    status: text(),
    _version: number(),
  },
});

// Creates the canonical sheet and task queue. Existing projection rows are
// copied into an empty canonical sheet during this one-time initialization.
await orders.ensureSheet();

await orders.transaction(async (tx) => {
  const order = await tx.findById("o1");

  if (order) {
    order.status = "paid";
    tx.save(order);
  }
});

const processor = createQueuedRepositoryQueueProcessor(adapter);
const result = await processor.processTaskQueue({ maxTransactions: 1 });
```

The queued repository requires an explicit transaction boundary for entity
operations. Use `tx.findAll()`, `tx.findById()`, `tx.save()`, and `tx.remove()`
inside `repository.transaction()`. The callback is materialized as one queue
transaction; it does not apply the change to the canonical sheet immediately.
Queue draining is an independent infrastructure operation exposed by
`createQueuedRepositoryQueueProcessor()`.

Queued repository reads use the adapter's canonical read operation. The visible
projection tab is seeded during initialization but is not automatically synced
by the current gateway processor.

Entity reads and writes are scoped to the transaction callback. Queue
retry/materialization details are internal implementation concerns; the public
API does not expose a transaction handle or queue task payload.

Queued repositories use a repository-local cache of confirmed canonical reads
for 5 seconds by default. Configure it with `cache: { ttlMs: 1000 }`, disable it
with `cache: { enabled: false }`, or use `ttlMs: 0` to disable reuse. Queued
payloads are never inserted into the cache; any queued write invalidates the
cache and a later read refreshes from the canonical sheet. This cache is local
to one Node.js process and is not a cross-server consistency mechanism.

## Documentation

- [Safety model and adapters](docs/safety-and-adapters.md)
- [Manual Apps Script gateway setup](templates/manual-apps-script-gateway/README.md)
- [Integration smoke test](docs/integration-smoke-test.md)
- [Task queue write model](docs/task-queue-write-model.md)
- [Setup layer plan](docs/setup-layer-plan.md)
- [SQL layer plan](docs/sql-layer-plan.md)

## Current Limitations

This project currently does not support joins, relations, SQL execution,
automatic retry/backoff, browser support, or automatic Apps Script gateway
installation. Direct repositories do not provide read caching. Queued
processing is explicit, queued transactions do not provide
database-level atomicity across separate canonical sheets, and the visible
projection is not automatically synchronized after processing.

When adopting queued writes for an existing sheet, run `ensureSheet()` once so
the gateway can seed an empty canonical sheet from the existing projection.
Queued repositories should then read and write through the canonical queue
workflow rather than mixing direct writes against the projection tab.

Apps Script and Google Sheets quotas apply. Keep live Google integration tests
opt-in and use a test spreadsheet or test sheet tab.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run test:integration
```

`npm run test:integration` requires real Google credentials and is not part of
the default verification path.
