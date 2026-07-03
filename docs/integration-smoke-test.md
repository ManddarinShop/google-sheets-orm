# Integration Smoke Test

Google Sheets integration tests are opt-in. They are not part of the default
`npm test` command because they require credentials, spreadsheet access, and
Google API quota.

The smoke test writes a temporary `.typed-sheets.json`, creates repositories
with `createRepositoryFromConfig()`, then inserts, reads, lists, updates, and
deletes timestamp-based rows.

Both config paths are supported:

- service-account direct Google Sheets API access
- Apps Script gateway access

The smoke test calls repository-level `ensureSheet()` before CRUD. If the
configured sheet tab is missing, the adapter creates it. If the header row is
empty, the repository writes this schema header. Apps Script gateway configs
perform sheet creation and header initialization in one locked gateway
operation.

| id | email | age | active | _version |
| --- | --- | --- | --- | --- |

If headers already exist, the test does not rewrite them. Schema drift still
fails.

## Service Account

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

## Apps Script Gateway

Deploy the gateway script and add the secret to `.env`:

```sh
GOOGLE_APPS_SCRIPT_GATEWAY_SECRET=your-gateway-secret
```

Then run:

```sh
GOOGLE_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/your-spreadsheet-id/edit \
GOOGLE_APPS_SCRIPT_GATEWAY_URL=https://script.google.com/macros/s/your-deployment-id/exec \
GOOGLE_APPS_SCRIPT_GATEWAY_SHEET_NAME=Users \
npm run test:integration
```

You can also put these values in `.env`; `npm run test:integration` loads
`.env` automatically when it exists. `GOOGLE_SERVICE_ACCOUNT_SHEET_NAME` and
`GOOGLE_APPS_SCRIPT_GATEWAY_SHEET_NAME` can be used to target different sheets;
both fall back to `GOOGLE_SHEET_NAME` and then `Users`.

If you are starting from `typed-sheets setup`, deploy the gateway script, copy
the deployed Web App `/exec` URL, reload the Google Sheet, click
`typed-sheets > Setup gateway` or run `setupTypedSheets()`, paste the `/exec`
URL into the Apps Script prompt, and paste the execution-log output into the
setup editor prompt.

On macOS, copy the gateway script without selecting terminal output:

```sh
pbcopy < templates/manual-apps-script-gateway/Code.gs
```

The CLI extracts the config JSON before writing `.typed-sheets.json`.

When a smoke path is skipped, the test name includes the missing environment
variables. For example, the Apps Script gateway smoke test requires
`GOOGLE_SPREADSHEET_URL`, `GOOGLE_APPS_SCRIPT_GATEWAY_URL`, and
`GOOGLE_APPS_SCRIPT_GATEWAY_SECRET`.
