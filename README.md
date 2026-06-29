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
  boolean,
  createSheetRepository,
  number,
  text,
  type SheetAdapter,
} from "typed-sheets";

interface User {
  id: string;
  email: string;
  age: number | undefined;
  active: boolean;
  _version: number;
}

const adapter: SheetAdapter = createYourGoogleSheetsAdapter();

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
}
```

The adapter owns authentication, Google API calls, range mapping, append, and row update mechanics.

The core owns schema validation, parsing, duplicate key detection, repository methods, and optimistic locking.

### 한국어

`typed-sheets` core는 Google SDK에 직접 의존하지 않습니다.

adapter는 인증, Google API 호출, range mapping, append, row update를 담당합니다.

core는 schema validation, parsing, duplicate key detection, repository method, optimistic locking을 담당합니다.

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
- Google Sheets adapter implementation

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
- Google Sheets adapter implementation

## Long-Term Direction

The long-term direction is a lightweight SQL layer backed by Google Sheets, closer to an online H2-like database experience for MVPs and internal tools.

Concurrency control and transaction semantics are later-stage work. The first priority is a typed table/storage model that can safely support repository operations and eventually a small SQL subset.

### 한국어

장기 방향은 Google Sheets를 storage로 사용하는 lightweight SQL layer입니다. MVP와 내부툴을 위한 online H2-like database 경험에 가깝습니다.

concurrency control과 transaction semantics는 후순위입니다. 우선순위는 repository operation과 향후 작은 SQL subset을 안전하게 지원할 수 있는 typed table/storage model입니다.

## Development

```sh
npm test
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
