# Manual Apps Script Gateway Spike

This is the open-source friendly setup path:

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

Use `SheetInfo.gs` when you only need to inspect the required Sheet values.
Deployment is not needed.

1. Open the target Google Sheet.

2. Open:

   ```txt
   Extensions > Apps Script
   ```

3. Copy `SheetInfo.gs` from this directory into Apps Script.

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

Use `Code.gs` when you want typed-sheets to connect through an Apps Script Web
App gateway.

1. Open the target Google Sheet.

2. Open:

   ```txt
   Extensions > Apps Script
   ```

3. Copy `Code.gs` from this directory into Apps Script.

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

6. Run `setupTypedSheets()` or reload the Google Sheet and click:

   ```txt
   typed-sheets > Setup gateway
   ```

7. Open Apps Script execution logs and copy the generated JSON.

8. Paste it into the `typed-sheets setup` editor prompt.

The CLI extracts the config JSON from the pasted text, validates it, and writes
`.typed-sheets.json`.

The gateway supports these operations:

- `ping`
- `ensureSheet`
- `initializeSheet`
- `writeHeader`
- `readSheet`
- `appendRow`
- `updateRow`
- `deleteRow`

`initializeSheet` creates the sheet when missing and writes headers when the
header row is empty while holding the document lock. `writeHeader` refuses to
overwrite a non-empty header row.

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
