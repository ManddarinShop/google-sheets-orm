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
5. Write a local JSON config file.

Example output:

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/...",
  "defaultSheetName": "Users",
  "auth": {
    "type": "oauth"
  }
}
```

## MVP Scope

- Node.js CLI only.
- OAuth login for local development.
- Spreadsheet URL parsing and validation.
- Config JSON generation.
- Clear failure when the user cannot access the spreadsheet.

## Out of Scope

- Browser runtime support.
- Transaction support.
- SQL execution.
- Apps Script gateway installation.
- Workspace admin policy automation.
- Secret storage abstraction.

## Design Notes

The repository layer should keep accepting explicit adapter options. The setup layer should only help users create those options more easily.

For production deployments, service accounts may still be the better option. OAuth setup primarily improves onboarding and local development accessibility.

## 한국어

목표는 `typed-sheets` 설치 이후 첫 Google Sheets 연결 성공까지의 과정을 쉽게 만드는 것입니다.

setup layer는 repository core가 아닙니다. application이 Google Sheets adapter에 넘길 local configuration을 만들어주는 역할입니다.

초기 MVP는 Node.js CLI, Google login, spreadsheet URL 입력, 접근 권한 검증, local JSON config 생성에 집중합니다.

production deployment에서는 service account가 여전히 더 적합할 수 있습니다. OAuth setup은 onboarding과 local development 접근성을 높이는 용도입니다.
