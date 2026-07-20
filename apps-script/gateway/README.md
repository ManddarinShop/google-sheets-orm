# Apps Script registry-bound sync gateway

This is the Apps Script boundary for the SQLite-authoritative sync runtime. It
accepts signed `typed-sheets-sync-v1` data-plane requests and signed
`typed-sheets-sync-admin-v1` registry-provisioning requests.

SQLite declares the complete projection registry. The gateway verifies the
signature, spreadsheet ID, expiry, payload hash, projection, tab, and
whole-column range before touching a Sheet. It does not choose a canonical
winner or infer deletes.

## Setup

1. Install the package in the service project:

   ```sh
   npm install typed-sheets@0.1.0-beta.1
   ```

2. Create or open the bound Apps Script project for the target spreadsheet.
3. Copy the gateway source into the Apps Script editor. On macOS:

   ```sh
   pbcopy < node_modules/typed-sheets/apps-script/gateway/Code.gs
   ```

   Copy [appsscript.json](./appsscript.json) into the Apps Script manifest as
   well. The same files are available in the repository at
   `apps-script/gateway/`.
4. Run `runSyncGatewaySelfTest` once in the Apps Script editor.
5. Deploy as a Web App executing as the deployment owner and copy the `/exec`
   URL.
6. Run `setupSyncGateway` in the Apps Script editor. It preserves an existing
   secret during migration and logs an untracked local environment block.
7. Let the trusted SQLite service call `provisionRegistry`; do not manually
   enter projection tabs or ranges in Apps Script.

The setup output uses:

```dotenv
TYPED_SHEETS_GATEWAY_URL="https://script.google.com/macros/s/<deployment-id>/exec"
TYPED_SHEETS_GATEWAY_SHARED_SECRET="<secret>"
TYPED_SHEETS_GATEWAY_SHEET_ID="<spreadsheet-id>"
```

Do not commit either the shared secret or the generated environment file.

## Security boundary

The gateway accepts signed POST requests only. It rejects unauthenticated GET
requests and does not expose a browser-facing setup route. Hiding a system tab
is not a permission boundary; spreadsheet owners can still reveal it.
