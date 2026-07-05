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

7. Run `setupTypedSheets()` or reload the Google Sheet and click:

   ```txt
   typed-sheets > Setup gateway
   ```

8. Paste that `/exec` URL into the Apps Script prompt.

9. Open Apps Script execution logs and copy the generated JSON.

10. Paste that JSON into the `typed-sheets setup` editor prompt.

The CLI extracts the config JSON from the pasted text, validates it, and writes
`.typed-sheets.json`.

Security note: the generated `gatewaySecret` is a credential. Treat it like a
password and do not commit it to version control.

The gateway supports these operations:

- `ping`
- `ensureSheet`
- `initializeSheet`
- `writeHeader`
- `readSheet`
- `appendRow`
- `appendRows`
- `updateRow`
- `deleteRow`

`initializeSheet` creates the sheet when missing and writes headers when the
header row is empty while holding the document lock. `writeHeader` refuses to
overwrite a non-empty header row. `appendRows` writes a burst of rows through one
gateway request so repository inserts can avoid per-row Apps Script calls.

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
