# Agent Git And PR Rules

## Branches

Use short-lived English kebab-case branches.

Examples:

- `feature/google-sheets-adapter`
- `feature/google-sheets-smoke-test`
- `docs/api-and-positioning`
- `fix/version-conflict`

Do not commit directly to `main`.

## Before Starting New Work

Before creating a new branch:

1. Check current branch.
2. Check working tree status.
3. Confirm whether the latest relevant PR has been merged.
4. Fast-forward local `main` from `origin/main` when needed.
5. Create a branch from the correct base.

## Stacked PRs

Only use stacked PRs when a prior PR has not been merged yet.

If stacked PRs are used:

- clearly mention the non-`main` base
- after the lower PR is merged, ensure the changes reach `main`
- do not assume a PR merged into a feature branch has reached `main`

## Commits

Use Conventional Commits.

Examples:

- `feat: add google sheets adapter`
- `test: add integration smoke scaffold`
- `docs: add adapter usage notes`
- `fix: handle empty sheet values`

Do not prefix commit messages with `[codex]`.

## PR Titles

Use plain English titles.

Examples:

- `Add Google Sheets adapter`
- `Add integration smoke test scaffold`
- `Document adapter authentication`

Do not prefix PR titles with `[codex]`.

## PR Body Language

Use bilingual PR bodies:

```md
## English

...

## 한국어

...
```

## Before Opening A PR

Run the relevant checks:

- `npm test`
- `npm run typecheck`
- `npm run build`

If the PR adds opt-in integration tests, also run:

- `npm run test:integration`

When integration credentials are absent, the expected result is a skipped integration test, not a failed default test.

## Staging

Stage explicit files only.

Do not use broad `git add -A` when ignored planning files, generated files, credentials, or unrelated changes may exist.

Never stage:

- `node_modules/`
- `dist/`
- credentials
- local env files
- ignored planning notes

## Credentials

Never commit:

- service account JSON
- `.env`
- OAuth token files
- `GOOGLE_APPLICATION_CREDENTIALS` target files
- any spreadsheet secret or token
