# typed-sheets

Typed repository and safe write layer for Google Sheets-backed MVPs.

`typed-sheets` is a TypeScript library for using Google Sheets as a lightweight, editable data store for early MVPs, internal tools, prototypes, and low-traffic admin workflows.

It is not a MySQL/Postgres replacement, not a full ORM, and not a general-purpose Google Sheets API wrapper. The core goal is to make unsafe spreadsheet-backed data states fail clearly instead of passing silently.

## 한국어

`typed-sheets`는 Google Sheets를 초기 MVP, 내부 운영툴, 프로토타입, 저트래픽 어드민의 lightweight editable data store로 사용할 때 필요한 TypeScript 라이브러리입니다.

이 프로젝트는 MySQL/Postgres 대체재도 아니고, full ORM도 아니며, 범용 Google Sheets API wrapper도 아닙니다. 핵심 목표는 spreadsheet-backed data에서 위험한 상태가 조용히 성공 처리되지 않도록 명확히 실패시키는 것입니다.

## Current MVP

The current MVP focuses on repository safety:

- schema drift validation
- typed row parsing
- key-based `findAll` and `findById`
- `insert`
- `update`
- `_version` based optimistic locking
- `SchemaDriftError`
- `ParseError`
- `ConflictError`
- adapter boundary for Google Sheets access

### 한국어

현재 MVP는 repository safety에 집중합니다.

- schema drift validation
- typed row parsing
- key 기반 `findAll`, `findById`
- `insert`
- `update`
- `_version` 기반 optimistic locking
- `SchemaDriftError`
- `ParseError`
- `ConflictError`
- Google Sheets 접근을 위한 adapter boundary

## Installation

This package is not published yet.

For local development:

```sh
npm install
npm test
npm run typecheck
npm run build
```

## Quick Start

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
```

`ensureSheet()` creates the `Users` tab when it is missing and writes the schema header only when the header row is empty. Existing headers are validated, not automatically rewritten.

### 한국어

`ensureSheet()`는 `Users` tab이 없으면 생성하고, header row가 비어 있을 때만 schema 기준 header를 작성합니다. 이미 존재하는 header는 자동 수정하지 않고 검증합니다.

## Sheet Shape

The first row is treated as the header row.

Example `Users` sheet:

| id | email | age | active | _version |
| --- | --- | --- | --- | --- |
| u1 | a@test.com | 20 | true | 1 |
| u2 | b@test.com |  | false | 1 |

`typed-sheets` maps cells by header order, not by hard-coded column position.

### 한국어

첫 번째 row는 header row로 취급합니다.

`typed-sheets`는 고정 column 위치가 아니라 header 순서로 cell을 매핑합니다.

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
  ensureSheet?(sheetName: string): Promise<void>;
  writeHeader?(sheetName: string, headers: string[]): Promise<void>;
}
```

The adapter owns authentication, Google API calls, range mapping, append, row update mechanics, and optional sheet initialization.

The core owns schema validation, parsing, duplicate key detection, repository methods, and optimistic locking.

### 한국어

`typed-sheets` core는 Google SDK에 직접 의존하지 않습니다.

adapter는 인증, Google API 호출, range mapping, append, row update, optional sheet initialization을 담당합니다.

core는 schema validation, parsing, duplicate key detection, repository method, optimistic locking을 담당합니다.

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

`ensureSheet` creates a missing sheet tab. Repository-level `ensureSheet()` writes schema headers only when the header row is empty. If headers already exist, it checks schema drift and does not auto-rewrite them.

It uses raw values where possible:

- `readSheet` uses `valueRenderOption: "UNFORMATTED_VALUE"`
- `appendRow` and `updateRow` use `valueInputOption: "RAW"`

### 한국어

`GoogleSheetsAdapter`는 repository core를 Google Sheets API에 연결합니다.

현재 구현된 메서드:

- `ensureSheet(sheetName)`
- `writeHeader(sheetName, headers)`
- `readSheet(sheetName)`
- `appendRow(sheetName, row)`
- `updateRow(sheetName, rowNumber, row)`

`ensureSheet`는 sheet tab이 없으면 생성합니다. repository-level `ensureSheet()`는 header row가 비어 있을 때만 schema 기준 header를 작성합니다. 이미 header가 있으면 schema drift만 검사하고 자동 수정하지 않습니다.

가능한 raw value 기준으로 동작합니다.

- `readSheet`는 `valueRenderOption: "UNFORMATTED_VALUE"` 사용
- `appendRow`, `updateRow`는 `valueInputOption: "RAW"` 사용

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

### 한국어

#### Schema Drift

schema drift는 `SchemaDriftError`로 실패합니다.

감지하는 경우:

- duplicate headers
- 선언된 column 누락
- key column 누락
- `_version` column 누락
- duplicate keys

extra sheet column은 기본 허용합니다.

#### Parse Errors

잘못된 row value는 `ParseError`로 실패합니다.

예:

- required value 누락
- invalid number
- invalid boolean

#### Optimistic Locking

`update(id, updater)`는 `_version`으로 stale write를 방지합니다.

이 방식은 stale-write protection이지 full database transaction이 아닙니다.

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
- Apps Script write gateway

### 한국어

현재 지원하지 않는 것:

- joins
- relations
- SQL execution
- migrations
- transactions
- multi-row atomic updates
- cache / request collapse
- retry / backoff
- browser support
- Apps Script write gateway

## Long-Term Direction

The long-term direction is a lightweight SQL layer backed by Google Sheets, closer to an online H2-like database experience for MVPs and internal tools.

Concurrency control and transaction semantics are later-stage work. The first priority is a typed table/storage model that can safely support repository operations and eventually a small SQL subset.

Before the SQL layer, the next priority is a setup layer that improves first-run accessibility:

- install the library
- run a setup command
- sign in with Google
- paste or enter a Google Sheets URL
- write a local JSON configuration file for the application to use

The setup layer should make the first successful connection easier without changing the repository safety model.

### 한국어

장기 방향은 Google Sheets를 storage로 사용하는 lightweight SQL layer입니다. MVP와 내부툴을 위한 online H2-like database 경험에 가깝습니다.

concurrency control과 transaction semantics는 후순위입니다. 우선순위는 repository operation과 향후 작은 SQL subset을 안전하게 지원할 수 있는 typed table/storage model입니다.

SQL layer 전에 우선할 작업은 first-run accessibility를 위한 setup layer입니다.

- library 설치
- setup command 실행
- Google login
- Google Sheets URL 입력
- application이 사용할 local JSON config 생성

setup layer는 repository safety model을 바꾸지 않고 첫 연결 성공까지의 과정을 쉽게 만드는 것이 목표입니다.

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

The smoke test calls repository-level `ensureSheet()` before CRUD. If the configured sheet tab is missing, the adapter creates it. If the header row is empty, the repository writes this schema header:

| id | email | age | active | _version |
| --- | --- | --- | --- | --- |

If headers already exist, the test does not rewrite them. Schema drift still fails.

For service account authentication:

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

You can also put these values in `.env`; `npm run test:integration` loads `.env` automatically when it exists.

The smoke test inserts a timestamp-based row and then updates it. It does not delete the row because the MVP adapter does not implement row deletion.

### 한국어

Google Sheets integration test는 opt-in입니다. credentials, spreadsheet access, Google API quota가 필요하므로 기본 `npm test`에는 포함하지 않습니다.

smoke test는 CRUD 전에 repository-level `ensureSheet()`를 호출합니다. 설정한 sheet tab이 없으면 adapter가 생성합니다. header row가 비어 있으면 repository가 아래 schema header를 작성합니다.

| id | email | age | active | _version |
| --- | --- | --- | --- | --- |

이미 header가 있으면 자동 수정하지 않습니다. schema drift는 여전히 실패합니다.

service account 인증 기준:

1. Google Cloud service account를 만들거나 선택합니다.
2. JSON key를 다운로드합니다.
3. 대상 spreadsheet를 service account email에 공유합니다.
4. 아래 명령을 실행합니다.

```sh
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
GOOGLE_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/your-spreadsheet-id/edit \
GOOGLE_SHEET_NAME=Users \
npm run test:integration
```

`.env`에 값을 넣어도 됩니다. `npm run test:integration`은 `.env`가 있으면 자동으로 읽습니다.

smoke test는 timestamp 기반 row를 insert한 뒤 update합니다. MVP adapter에는 row deletion이 없으므로 테스트 row를 삭제하지 않습니다.
