# typed-sheets

`typed-sheets` is a typed SQLite entity store and a service-side Google Sheets
sync runtime for MVPs, internal tools, prototypes, and low-traffic admin
workflows.

The project is currently published as a beta. The beta gives you two related,
but deliberately separate, capabilities:

1. a small standalone `EntityStore` for creating and operating on
   application-owned SQLite tables;
2. a SQLite-authoritative sync runtime that materializes registered projections
   in Google Sheets through a signed Apps Script gateway.

This package is not a general-purpose ORM, a MySQL/Postgres replacement, or a
general Google Sheets API wrapper. It does not try to hide SQLite, turn Sheets
into a transactional database, or infer an application's domain model.

## Beta status and compatibility

The beta API is intended for evaluation and small services. The current
release requires Node.js 22.5 or newer because it uses Node's built-in
`node:sqlite` module. `node:sqlite` is still experimental in supported Node
releases, so pin your Node version in CI and deployment environments.

The npm `latest` tag may point to a different release line. Install this beta
explicitly:

```sh
npm install typed-sheets@0.1.0-beta.1
```

After publication, the moving beta tag can also be used:

```sh
npm install typed-sheets@beta
```

## What the package does

### Standalone SQLite entities

You declare a row shape and a table definition. The store creates the table if
it is missing, verifies an existing table, and exposes a deliberately small
entity-style API:

```text
open database -> define entity -> save(entity) -> findById/findAll -> remove
```

`save(entity)` is an insert-or-update operation. To update an entity, load it,
mutate it, and save it again:

```ts
const item = items.findById("item-1");

if (item !== null) {
  item.count += 1;
  items.save(item);
}
```

The beta does not include joins, relations, query builders, decorators,
automatic migrations, lazy loading, or ORM-specific lifecycle hooks.

### SQLite-authoritative Sheets sync

The sync runtime keeps the canonical entity state, revisions, observations,
conflicts, resolution commands, writer leases, and pending Sheet effects in
SQLite. A trusted server-side client sends only registered, signed projection
effects to Apps Script. Apps Script validates the request and performs the
guarded Sheet write.

The normal data path is:

```text
service/adapter -> SQLite canonical state + outbox
                         |
                         v
                 signed Apps Script request
                         |
                         v
                 registered Google Sheet projection
```

The standalone `EntityStore` does not automatically create sync effects. An
application or ORM adapter must connect its transaction boundary to the sync
writer when both behaviors are needed.

## Standalone EntityStore

### Define a table

The minimal supported column kinds are:

| Kind | Type accepted by `save` | SQLite type | Notes |
| --- | --- | --- | --- |
| `TEXT` | `string` | `TEXT` | nullable when declared with `nullable: true` |
| `INTEGER` | safe integer | `INTEGER` | `Number.isSafeInteger` is required |
| `REAL` | finite number | `REAL` | `NaN` and infinities are rejected |
| `BOOLEAN` | `boolean` | `INTEGER` | stored as `0` or `1` |

Example:

```ts
import {
  ENTITY_COLUMN_KINDS,
  openStandaloneEntityStore,
  type EntityDefinition,
} from "typed-sheets";

type Item = {
  id: string;
  label: string;
  count: number;
  enabled: boolean;
  note: string | null;
};

const itemDefinition: EntityDefinition<Item> = {
  tableName: "items",
  primaryKey: "id",
  columns: {
    id: { kind: ENTITY_COLUMN_KINDS.TEXT },
    label: { kind: ENTITY_COLUMN_KINDS.TEXT },
    count: { kind: ENTITY_COLUMN_KINDS.INTEGER },
    enabled: { kind: ENTITY_COLUMN_KINDS.BOOLEAN },
    note: { kind: ENTITY_COLUMN_KINDS.TEXT, nullable: true },
  },
};

const items = await openStandaloneEntityStore({
  databasePath: "./data.sqlite",
  definition: itemDefinition,
});

items.save({
  id: "item-1",
  label: "first",
  count: 1,
  enabled: true,
  note: null,
});

const item = items.findById("item-1");
const allItems = items.findAll();
const removed = items.remove("item-1");

console.log({ item, allItems, removed });
items.close();
```

### Definition rules

- `tableName`, `primaryKey`, and column names must be safe SQLite identifiers:
  letters/underscores first, followed by letters, numbers, or underscores.
  Hyphens are intentionally rejected so table names cannot become SQL syntax.
  Use names such as `final_demo_user`, not `final-demo-user`.
- The primary-key column must be declared and cannot be nullable.
- Every declared column is required in a value passed to `save`; use
  `nullable: true` when `null` is a valid value.
- The store does not silently coerce strings to numbers, booleans to strings,
  or arbitrary objects to JSON.
- `findById` returns `null` when the key is absent.
- `remove` returns `true` only when a row was deleted and `false` when no row
  matched.
- `findAll` returns the declared row shape and is ordered by the primary key.

### Open an existing connection

Use `openStandaloneEntityStore` when the helper should own the database
connection. If the service already opened SQLite, initialize the sync schema
as needed and create a store on that connection:

```ts
import {
  createEntityStore,
  migrateSchema,
  openDatabase,
} from "typed-sheets";

const database = await openDatabase("./data.sqlite");
migrateSchema(database);

const items = createEntityStore(database, itemDefinition);
items.save({
  id: "item-2",
  label: "second",
  count: 2,
  enabled: false,
  note: "created on an existing connection",
});

database.close();
```

`ensureEntityTables(database, definitions)` can verify or create several
definitions inside one writer transaction. The current beta keeps the
application table definition explicit; it does not infer schema from a class
or from an existing ORM model.

### Schema drift behavior

On startup, the store creates a missing application table. If a table already
exists but its declared columns, SQLite types, nullability, or primary key do
not match, startup fails with `EntitySchemaMismatchError`. The store never
drops, rewrites, or guesses a migration for an existing table.

This is intentional: a beta service should stop at a definition mismatch
instead of silently changing user data. Apply application-table migrations
explicitly before starting the service, then start with the new definition.

The store also exposes these errors for boundary handling:

- `EntityDefinitionError`: invalid table/column definition or identifier;
- `EntitySchemaMismatchError`: an existing table differs from the definition;
- `EntityValueError`: a row value does not match its declared column kind.

## Internal SQLite sync schema

`openStandaloneEntityStore()` initializes the internal sync schema by default
before creating the declared application table. The internal tables are
separate from your application-owned entity tables and include the durable
records needed for:

- logical and physical Sheet registration;
- row bindings and projection anchors;
- canonical entity and field revisions;
- observed Sheet edits and event identities;
- quarantine records for structurally invalid observations;
- conflicts and resolution command receipts;
- writer leases and fencing tokens;
- the Sheet effect outbox and effect receipts.

Do not write to those internal tables directly from application code. Use the
storage/runtime APIs or an adapter at the service transaction boundary.

## Apps Script gateway setup

The gateway is optional for a local SQLite-only application. You need it when
the service must materialize projections in Google Sheets.

### 1. Install the package and print the setup guide

```sh
npm install typed-sheets@0.1.0-beta.1
npx typed-sheets setup
```

The CLI is intentionally non-interactive. It prints the packaged source and
manifest locations, plus the macOS copy command:

```text
pbcopy < node_modules/typed-sheets/apps-script/gateway/Code.gs
```

On another platform, open that file directly or copy it with the platform's
file-copy command. The source is shipped inside the npm package; no repository
checkout is needed.

### 2. Create the Apps Script project

Create or open the bound Apps Script project for the target spreadsheet.
Replace the editor contents with `Code.gs`, and copy
`appsscript.json` into the Apps Script manifest.

Run this function once in the Apps Script editor:

```text
runSyncGatewaySelfTest
```

The self-test checks the gateway's local protocol and configuration helpers.

### 3. Deploy the Web App

Deploy the Apps Script project as a Web App with execution owned by the
deployment owner. Copy the deployed `/exec` URL. The service must call the
HTTPS URL; the client rejects non-HTTPS gateway URLs.

Run this setup function in Apps Script:

```text
setupSyncGateway
```

The setup function prepares the gateway configuration and preserves an
existing secret during migration. It emits a local environment block; keep it
out of Git.

### 4. Configure the trusted service

Use environment variables or an equivalent secret manager:

```dotenv
TYPED_SHEETS_GATEWAY_URL="https://script.google.com/macros/s/<deployment-id>/exec"
TYPED_SHEETS_GATEWAY_SHARED_SECRET="<shared-secret>"
TYPED_SHEETS_GATEWAY_SHEET_ID="<spreadsheet-id>"
```

Never put the shared secret in browser code, a public bundle, a committed
`.env` file, or a client-side request. The gateway is a server/CI boundary.

Create a signed client in the service:

```ts
import { AppsScriptSyncGatewayClient } from "typed-sheets";

const gateway = new AppsScriptSyncGatewayClient({
  url: process.env.TYPED_SHEETS_GATEWAY_URL!,
  secret: process.env.TYPED_SHEETS_GATEWAY_SHARED_SECRET!,
  sheetId: process.env.TYPED_SHEETS_GATEWAY_SHEET_ID!,
  actorId: "my-service-sync-worker",
});
```

The service-side registry is authoritative for tab names, ranges, projection
kinds, headers, and schema versions. Call
`provisionRegisteredSyncSheets` with the routes declared in SQLite. The
gateway creates missing tabs and initializes a fully blank header row, but it
does not overwrite a nonblank mismatched header.

```ts
import { provisionRegisteredSyncSheets } from "typed-sheets";

await provisionRegisteredSyncSheets(gateway, registeredProjections);
```

`registeredProjections` must be the complete set for one spreadsheet. A
`Sync_Conflicts` projection may declare boolean `checkboxHeaders`; those cells
are the one-shot control surface for trusted resolution commands.

### Gateway security boundary

- Data-plane requests are signed and include the configured spreadsheet ID.
- The gateway verifies the registered projection, tab, whole-column range,
  schema version, expiry, and payload hash before writing.
- The gateway does not choose a canonical winner or infer a delete from a
  missing row.
- Hiding or protecting a system tab improves usability but is not a security
  boundary; a spreadsheet owner can still reveal it.
- Give the spreadsheet and Apps Script project only the permissions required by
  the service owner, and rotate the shared secret if it is exposed.

## Conflict behavior

The runtime treats SQLite as the canonical service state and keeps the Sheet
projections guarded by visible revisions and hashes.

When a user edits a `user_input` projection while a canonical write targets
the same field:

1. the system projection can advance to the server value;
2. the user projection remains protected from a silent overwrite;
3. SQLite records an `OPEN` conflict with the candidate value, base revision,
   current canonical value, and candidate epoch;
4. a checkbox with `TRUE` requests `acknowledge_system` only after the service
   validates the conflict ID, canonical revision, candidate hash, and candidate
   epoch;
5. a successful acknowledgement marks the SQLite conflict `RESOLVED`, clears
   the active candidate pointer, and removes the visible conflict row from the
   `Sync_Conflicts` projection;
6. SQLite retains the conflict and resolution-command audit rows.

An acknowledgement does not treat arbitrary Sheet text as authority. If the
revision/hash/epoch is stale, the command is not applied. The visible
`*_System_State` projection shows the canonical server value; the edited
`*_Input` value can remain visible as the user's candidate until a later
canonical projection or explicit edit changes it.

## Local development and verification

From this checkout:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

To verify exactly what will be published:

```sh
npm pack --dry-run
npm pack
npm install ./typed-sheets-0.1.0-beta.1.tgz
npx typed-sheets setup
```

The normal test suite is local and does not require Google credentials. Live
gateway tests require a deployed Apps Script Web App, a spreadsheet allowlist,
and the three environment variables above. Keep those tests opt-in because
Apps Script latency and quotas are external to the local unit suite.

## Current limitations and roadmap

The beta intentionally leaves these tasks to a later release:

- relations, joins, query builders, and ORM decorators;
- automatic application-table migrations;
- JSON/date/array column codecs in `EntityStore`;
- automatic wiring from arbitrary ORM transactions to the sync outbox;
- a production-grade job scheduler and horizontal worker coordination;
- automatic conflict winner selection;
- a stable API promise for every low-level sync storage primitive.

For a large relational workload, strict transactional requirements, complex
queries, or high-frequency concurrent writes, use a relational database as the
primary store and integrate the sync runtime at the ORM transaction boundary.

## License

MIT
