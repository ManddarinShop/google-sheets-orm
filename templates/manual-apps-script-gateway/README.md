# Manual Apps Script Gateway

This is the open-source friendly Apps Script setup path:

- no typed-sheets OAuth client ID
- no Google Cloud Console setup
- no service account for the default path
- no Marketplace Add-on
- one copy-pasted Apps Script file owned by the spreadsheet owner

## Flow

`typed-sheets setup` can show this setup in two ways:

- it prints both reference paths:
  - `templates/manual-apps-script-gateway/SheetInfo.gs`
  - `templates/manual-apps-script-gateway/Code.gs`
- it can optionally print a platform-specific copy command for either script

## Sheet Info Helper

Use `SheetInfo.gs` only when you want to inspect the Sheet URL and default tab.
It is a run-only helper; deployment is not needed.

1. Open the target Google Sheet.

2. Open:

   ```txt
   Extensions > Apps Script
   ```

3. Copy `SheetInfo.gs` into Apps Script.

   On macOS:

   ```sh
   pbcopy < templates/manual-apps-script-gateway/SheetInfo.gs
   ```

4. Run this function in Apps Script:

   ```txt
   setupTypedSheetsSheetInfo
   ```

5. Open Apps Script execution logs and copy the generated JSON.

This helper prints:

```json
{
  "spreadsheetId": "...",
  "spreadsheetUrl": "...",
  "defaultSheetName": "..."
}
```

## Full Gateway

Use `Code.gs` to connect typed-sheets to this spreadsheet through an Apps Script
Web App gateway.

1. Open the target Google Sheet.

2. Open:

   ```txt
   Extensions > Apps Script
   ```

3. Copy `Code.gs` into Apps Script.

   On macOS:

   ```sh
   pbcopy < templates/manual-apps-script-gateway/Code.gs
   ```

4. Deploy it as a web app:

   ```txt
   Deploy > New deployment > Web app
   Execute as: Me
   Who has access: Anyone
   ```

5. Approve Google permissions if Apps Script asks.

6. Copy the Web App URL shown after deployment. It must end with `/exec`.

7. Paste that URL into `TYPED_SHEETS_GATEWAY_URL` near the top of `Code.gs`.

8. Run `setupTypedSheets()` from the Apps Script editor.

9. Open Apps Script execution logs and copy the generated JSON.

10. Paste that JSON into the `typed-sheets setup` editor prompt.

The CLI extracts the config JSON from the pasted text, validates it, and writes
`.typed-sheets.json`.

Security note: the generated `gatewaySecret` is a credential. Treat it like a
password and do not commit it to version control.

The gateway supports these queue/system operations:

- `ping`
- `initializeSystemSheets`
- `enqueueTasks`
- `processTaskQueue`
- `readSheet`

The gateway still accepts these legacy direct-write operations for existing
`createRepositoryFromConfig()` Apps Script users while repository writes move to
the task queue:

- `ensureSheet`
- `initializeSheet`
- `writeHeader`
- `appendRow`
- `appendRows`
- `updateRow`
- `updateRowsByKey`
- `deleteRow`
- `deleteRows`
- `deleteRowsByKey`

`initializeSheet` creates the sheet when missing and writes headers when the
header row is empty while holding the document lock. `initializeSystemSheets`
creates the visible projection sheet plus the hidden/protected canonical data
sheet and hidden/protected task queue sheet used by the queued write model.
Apps Script sheet protection is best-effort and spreadsheet owners can still
edit protected sheets, so queued writes must still validate internal rows.
`enqueueTasks` appends one transaction worth of caller-supplied write tasks to
the hidden task queue and assigns monotonic sequence values while holding the
document lock; it does not process or materialize queued tasks.
`processTaskQueue` processes a bounded number of pending transaction groups
into hidden canonical sheets and marks each group `done` or `failed`; projection
sync and stale `processing` recovery are still future work.
`writeHeader` refuses to overwrite a non-empty header row. `appendRows` writes a
burst of rows through one gateway request so repository inserts can avoid
per-row Apps Script calls. `deleteRows` deletes data rows from bottom to top in
one gateway request so batched repository deletes do not corrupt row numbers as
Google Sheets shifts rows upward. `deleteRowsByKey` lets gateway-backed
repositories validate keys and `_version` under the Apps Script document lock
before deleting, avoiding an extra client-side read round trip.
`updateRowsByKey` applies the same locked key and `_version` validation before
updating rows, avoiding an extra client-side read round trip for gateway-backed
updates.

Invalid requests return a JSON response with `ok: false`, an error `code`, and
a human-readable `message`.

## Gateway Ping

After `.typed-sheets.json` is generated, test the gateway:

```sh
curl -s -L "$GATEWAY_URL" \
  -H "content-type: application/json" \
  -d '{"operation":"ping","secret":"YOUR_GATEWAY_SECRET"}'
```

Expected shape:

```json
{
  "ok": true,
  "locked": true,
  "spreadsheetId": "...",
  "sheetName": "..."
}
```
