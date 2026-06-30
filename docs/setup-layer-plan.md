# Setup Layer Plan

## Goal

Make the first successful Google Sheets connection easy after installing `typed-sheets`.

The setup layer is not part of the repository core. It should generate local configuration that an application can pass into the Google Sheets adapter.

## Target Flow

```sh
npx typed-sheets setup
```

Expected flow:

1. Start Google login.
2. Ask for a Google Sheets URL.
3. Validate that the signed-in account can access the spreadsheet.
4. Ask for a default sheet tab name.
5. Store an OAuth refresh token in a local token file.
6. Write a local JSON config file that points to that token file.

Example output:

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/...",
  "defaultSheetName": "Users",
  "auth": {
    "type": "oauth",
    "tokenFile": ".typed-sheets/token.json"
  }
}
```

Token file example:

```json
{
  "type": "authorized_user",
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "..."
}
```

## MVP Scope

- Node.js CLI only.
- OAuth login as the default setup path.
- A `typed-sheets` managed OAuth client for the CLI flow.
- Offline access using a refresh token.
- Token file based runtime access so an app does not need to log in again on every server start.
- Spreadsheet URL parsing and validation.
- Config JSON generation.
- Clear failure when the user cannot access the spreadsheet.

## Authentication Decision

The MVP should optimize for the installed-library experience:

```sh
npx typed-sheets setup
```

The user should not have to create their own Google Cloud OAuth client just to try the library. The CLI should provide the OAuth client flow, ask for Google login once, request Google Sheets access, and save a refresh token locally.

At runtime, the application reads the generated config and token file. A deployed Node.js server should receive the token file contents through deployment secrets or a mounted secret file. It should not require an interactive Google login on every deploy or process restart.

Service account support remains useful, but it is an advanced or fallback path, not the default MVP onboarding path.

## OAuth Risks To Validate

- Google OAuth consent screen status may affect external users.
- Google may require verification for sensitive scopes.
- The CLI must request offline access and may need consent prompting to receive a refresh token.
- A public/open-source CLI cannot treat an embedded client secret as a real secret.
- Refresh tokens can be revoked by the user or blocked by Workspace policy.
- Token files are credentials and must never be committed.

## Out of Scope

- Browser runtime support.
- Transaction support.
- SQL execution.
- Apps Script gateway installation.
- Workspace admin policy automation.
- Secret storage abstraction.

## Design Notes

The repository layer should keep accepting explicit adapter options. The setup layer should only help users create those options more easily.

The default setup path should be OAuth because the target experience is a user installing the library, logging in once, pasting a spreadsheet URL, and receiving a usable config. Service account support should remain documented for teams that prefer server-to-server credentials, but it should not be the main MVP path.

## 한국어

목표는 `typed-sheets` 설치 이후 첫 Google Sheets 연결 성공까지의 과정을 쉽게 만드는 것입니다.

setup layer는 repository core가 아닙니다. application이 Google Sheets adapter에 넘길 local configuration을 만들어주는 역할입니다.

초기 MVP는 Node.js CLI, Google login, spreadsheet URL 입력, 접근 권한 검증, OAuth refresh token 저장, local JSON config 생성에 집중합니다.

기본 경로는 service account가 아니라 `typed-sheets`가 제공하는 OAuth client 기반 로그인입니다. 사용자는 직접 Google Cloud OAuth client를 만들지 않고 `npx typed-sheets setup`을 실행해 로그인하고, spreadsheet URL과 기본 sheet tab 이름을 입력하면 됩니다.

생성되는 config는 token file을 가리킵니다.

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/...",
  "defaultSheetName": "Users",
  "auth": {
    "type": "oauth",
    "tokenFile": ".typed-sheets/token.json"
  }
}
```

배포된 Node.js 서버는 매번 Google login을 다시 하는 방식이 아니라, token file 내용을 배포 secret 또는 mounted secret file로 받아 사용해야 합니다.

service account는 여전히 유용하지만 MVP 기본 onboarding 경로가 아니라 advanced/fallback 경로로 둡니다.
