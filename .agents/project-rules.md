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

Keep the open-source default path independent from a `typed-sheets` managed OAuth client ID.

The two supported connection paths are:

1. Manual Apps Script gateway setup
   - `typed-sheets` provides copy-paste Apps Script code.
   - The user pastes it into the target spreadsheet's Apps Script project.
   - The script is deployed as a web app by the spreadsheet owner.
   - The script logs `.typed-sheets.json` config for the user to copy.
   - Runtime uses `gatewayUrl` + `gatewaySecret`.
   - This path enables `LockService` for storage-side write coordination.

2. Service account setup
   - Advanced/server/CI path.
   - The user provides a service account JSON file path.
   - The target Sheet must be shared with the service account email.

Do not make managed OAuth, OAuth Device Flow, or Google Workspace Add-on installation the default path. They may be revisited later, but they introduce `typed-sheets` project identity, Marketplace review, or client-secret problems that do not fit the current open-source release direction.

Credentials and generated configs must never be committed.

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

## Code Writing Rules

Highest priority:

- Do not modify production source files under `src/**` unless the user explicitly asks for production implementation work.
- No inference is allowed. Even if the next step seems obvious, do not edit `src/**` without fresh explicit user approval for that exact production edit.
- Writing tests is never permission to modify production source.

Before starting any new task:

1. Re-read `.agents/project-rules.md`.
2. If the request is ambiguous, choose the safer interpretation.
3. Edit tests, docs, or configuration only when directly requested.
4. Do not edit `src/**` unless production implementation was explicitly requested.

Dependency requests authorize dependency/config changes only. They do not
authorize runtime wiring, CLI behavior changes, or feature implementation.

Production source includes:

- `src/**/*.ts`
- public exports in `src/index.ts`
- adapter implementations
- repository/core implementation
- any file that becomes part of the published package runtime

Allowed without extra confirmation when they match the user request:

- tests under `test/**`
- integration test scaffolding under `test/integration/**`
- documentation and planning files
- `.gitignore`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- other build/test configuration files

When the user asks for tests:

- edit only `test/**` unless explicitly told otherwise
- do not modify `src/**` to make tests pass
- run the relevant test command
- report expected failures clearly

When the user asks for explanation, design, plan, review, or "what should I do
next":

- do not edit `src/**`
- explain the next production change in prose
- wait for explicit approval before applying production changes

Only edit `src/**` when the user says something equivalent to:

- "구현해줘"
- "수정해줘"
- "고쳐줘"
- "src도 작업해줘"
- "프로덕션 코드 변경해줘"
- "apply it"
- "make the code change"

Ambiguous phrases like "다음", "진행해", "테스트 추가해줘", "설명해줘",
"이 기능이 필요해", "자동으로 동작해야 해", and "어떻게 해야 해" are not
enough to modify `src/**`.

Before any production edit:

1. State which production file will be edited.
2. State why it is necessary.
3. Confirm the user explicitly requested production implementation.

Implementation style:

- Keep changes small and focused.
- Prefer existing local patterns.
- Do not add unrelated abstractions.
- Do not refactor unrelated code.
- Use `apply_patch` for manual edits.
- Do not commit generated files.

## Git And PR Rules

Branches:

- Use short-lived English kebab-case branches.
- Examples: `feature/google-sheets-adapter`, `docs/api-and-positioning`,
  `fix/version-conflict`.
- Do not commit directly to `main`.

Before starting new work:

1. Check current branch.
2. Check working tree status.
3. Confirm whether the latest relevant PR has been merged.
4. Fast-forward local `main` from `origin/main` when needed.
5. Create a branch from the correct base.

Stacked PRs:

- Use stacked PRs only when a prior PR has not been merged yet.
- Clearly mention the non-`main` base.
- After the lower PR is merged, ensure the changes reach `main`.

Commits:

- Use Conventional Commits.
- Examples: `feat: add google sheets adapter`, `test: add integration smoke scaffold`,
  `docs: add adapter usage notes`, `fix: handle empty sheet values`.
- Do not prefix commit messages with `[codex]`.
- Do not include `codex` branding in commit messages.

PRs:

- Open a PR when a coherent work unit is finished.
- Use plain English PR titles.
- Do not prefix PR titles with `[codex]`.
- Do not include `codex` branding in PR titles or PR bodies.
- Use bilingual PR bodies with `## English` and `## 한국어` sections.
- Include summary, why, changes, tests, and limitations when relevant.

Before opening a PR, run relevant checks:

- `npm test`
- `npm run typecheck`
- `npm run build`

If the PR adds opt-in integration tests, also run:

- `npm run test:integration`

Staging:

- Stage explicit files only.
- Do not use broad `git add -A` when ignored planning files, generated files,
  credentials, or unrelated changes may exist.
- Never stage `node_modules/`, `dist/`, credentials, local env files, ignored
  planning notes, OAuth token files, or service account JSON files.

## Agent Conduct For This Repo

When in doubt:

0. Before starting any task, re-read `.agents/project-rules.md`.
1. Prefer tests, docs, or explanation over production edits.
2. Do not edit `src/**` without explicit implementation permission.
3. Treat dependency installation as dependency/config permission only, not runtime implementation permission.
4. Keep changes small.
5. Preserve the core/adapter/SQL layering.
6. Report exact commands run and test results.
