# Agent Code Writing Rules

## Highest Priority Rule

Do not modify production source files under `src/**` unless the user explicitly asks for production implementation work.

This is a hard rule for this repository.

No inference is allowed. Even if the next step seems obvious, even if tests fail, even if the feature cannot pass without production changes, do not edit `src/**` without a fresh explicit user approval for that exact production edit.

Writing tests is never permission to modify production source.

## Mandatory Pre-Work Rule Check

Before starting any new task, read these agent rule files again:

- `.agents/code-writing-rules.md`
- `.agents/project-rules.md`
- `.agents/git-rules.md`

Do this before interpreting the user's request, before editing files, and before running implementation commands.

If the request is ambiguous after reading the rules, choose the safer interpretation:

- explain the next step
- edit tests/docs/config only when directly requested
- do not edit `src/**`

## Dependency Requests Are Not Production Permission

When the user asks to install or add a dependency, that request authorizes dependency/config changes only.

It does not authorize:

- editing `src/**`
- wiring the dependency into runtime code
- changing CLI behavior
- implementing the feature that will eventually use the dependency

After adding a dependency, stop and report the result unless the user separately and explicitly asks for production implementation.

## What Counts As Production Source

Production source includes:

- `src/**/*.ts`
- public exports in `src/index.ts`
- adapter implementations
- repository/core implementation
- any file that becomes part of the published package runtime

## Allowed Without Extra Confirmation

These files may be edited when they match the user's request:

- tests under `test/**`
- integration test scaffolding under `test/integration/**`
- documentation such as `README.md`
- planning documents
- `.gitignore`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- other build/test configuration files

## When User Asks For Tests

If the user asks for tests:

- edit only `test/**` unless explicitly told otherwise
- do not implement production code to make the tests pass
- do not modify `src/**` to satisfy newly written tests
- run the relevant test command
- report expected failures clearly
- tell the user what production code they need to implement next

## When User Asks For Explanation Or Plan

If the user asks for explanation, design, plan, review, or "what should I do next":

- do not edit `src/**`
- explain the next production change in prose
- include code snippets only as guidance
- wait for explicit user approval before applying production changes

## When Production Code Looks Wrong

If production code appears incorrect:

- do not opportunistically fix it
- describe the issue and exact file/function
- explain the recommended change
- ask or wait for the user to explicitly request the edit

## Explicit Phrases That Allow `src/**` Edits

Only edit `src/**` when the user says something equivalent to:

- "구현해줘"
- "수정해줘"
- "고쳐줘"
- "src도 작업해줘"
- "프로덕션 코드 변경해줘"
- "apply it"
- "make the code change"

Ambiguous phrases like "다음", "진행해", "테스트 추가해줘", "설명해줘", "이 기능이 필요해", "자동으로 동작해야 해", "어떻게 해야 해" are not enough to modify `src/**`.

If the user asks for a feature or says a feature is needed, first explain the test plan or implementation plan. Do not touch `src/**` until the user explicitly says to edit production code.

## Before Editing `src/**`

Before any production edit:

1. State which production file will be edited.
2. State why it is necessary.
3. Confirm the user explicitly requested production implementation.

If that confirmation is absent, do not edit.

If the user only approved tests, documentation, configuration, or planning, treat production source as read-only.

## Style

- Keep implementation small and focused.
- Prefer existing local patterns.
- Do not add unrelated abstractions.
- Do not refactor unrelated code.
- Use `apply_patch` for manual edits.
- Do not use generated files in commits.
