# Setup Layer Plan

## Goal

Make the first successful Google Sheets connection possible without requiring a
`typed-sheets` managed OAuth client ID, Google Workspace Add-on installation, or
Google Cloud Console setup for the default path.

The setup layer is not repository core. It creates local configuration that an
application can pass into runtime adapter factories.

## Supported Connection Paths

### 1. Service Account

This is the recommended server/CI path.

Expected flow:

1. User creates or receives a service account JSON file.
2. User shares the Google Sheet with the service account `client_email`.
3. `typed-sheets setup` asks for:
   - spreadsheet URL
   - default sheet tab
   - service account JSON key path
4. `typed-sheets setup` writes `.typed-sheets.json`.

Config example:

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/...",
  "defaultSheetName": "Users",
  "auth": {
    "type": "service-account",
    "credentialsFile": "/absolute/path/to/service-account.json"
  }
}
```

Runtime direction:

```txt
Node app
-> typed-sheets library
-> Google Sheets API
-> Google Sheet
```

### 2. Manual Apps Script Gateway

This is the open-source-friendly path for users who want to avoid Google Cloud
OAuth setup.

Expected flow:

1. User opens the target Google Sheet.
2. User opens `Extensions > Apps Script`.
3. `typed-sheets setup` prints:
   - a short step-by-step guide
   - the small `SheetInfo.gs` reference path
   - the full `Code.gs` gateway reference path
4. User can choose which copy command to print in the terminal:
   - nothing
   - the small sheet info helper copy command
   - the full gateway script copy command
5. For the small helper, user copies `SheetInfo.gs` and runs
   `setupTypedSheetsSheetInfo()`.
   No Web App deployment is needed. This prints sheet identity values only.
6. For the gateway setup, user copies the provided `Code.gs` gateway script.
7. User deploys the gateway script as a Web App.
8. User runs `setupTypedSheets()`.
9. Apps Script logs the generated config JSON.
10. User pastes the JSON into the setup prompt.
11. `typed-sheets setup` writes `.typed-sheets.json`.

Config example:

```json
{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/...",
  "defaultSheetName": "Users",
  "auth": {
    "type": "apps-script-gateway",
    "gatewayUrl": "https://script.google.com/macros/s/.../exec",
    "gatewaySecret": "..."
  }
}
```

Runtime direction:

```txt
Node app
-> typed-sheets library
-> Apps Script gateway URL
-> Google Sheet
```

The Apps Script gateway can later own storage-side coordination such as
`LockService`, basic gateway authentication, and atomic read-check-write
primitives.

## Explicitly Not Default

- Managed OAuth client ID
- OAuth Device Flow
- Google Workspace Marketplace Add-on
- Hosted gateway service

These may be revisited later, but they create project identity, marketplace
review, client secret, or hosted-service responsibility that does not fit the
current open-source release direction.

## Risks To Validate

- Manual Web App deployment is still a setup burden.
- `gatewaySecret` is a credential and must never be committed.
- Apps Script quota and runtime limits apply.
- Service account setup remains difficult for non-developers.

## 한국어

지원하는 초기 연결 방식은 service account와 수동 Apps Script gateway입니다.

Service account는 서버, CI, 회사 인프라에서 credential을 직접 관리하는 경로입니다.
사용자는 대상 Google Sheet를 service account `client_email`에 공유하고,
`typed-sheets setup`에서 spreadsheet URL, 기본 sheet tab, JSON key 경로를 입력합니다.

Apps Script 방식은 두 파일을 분리합니다.

- `SheetInfo.gs`: 작은 helper입니다. 웹 앱 배포 없이 Run만 실행하면
  `spreadsheetId`, `spreadsheetUrl`, `defaultSheetName`을 로그에 출력합니다.
- `Code.gs`: 전체 gateway입니다. 대상 Google Sheet의 Apps Script에 붙여넣고,
  웹 앱으로 배포한 뒤 `setupTypedSheets()`를 실행합니다. 이 스크립트가 gateway
  URL과 secret을 포함한 config JSON을 Apps Script 실행 로그에 출력합니다.

`typed-sheets setup`은 두 파일 경로를 모두 보여주고, 필요한 경우에만 현재 OS에
맞는 복사 명령을 출력합니다. 스크립트 본문은 터미널에 출력하지 않습니다. gateway
config JSON은 setup 프롬프트에 붙여넣습니다.

이 방식은 다음을 피합니다.

- `typed-sheets` 공식 OAuth client ID
- 사용자의 Google Cloud OAuth client 생성
- Service Account 기본 강제
- Google Workspace Add-on 설치
- Marketplace 심사
