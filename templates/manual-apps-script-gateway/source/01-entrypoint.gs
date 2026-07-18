// Source module for the generated manual Apps Script gateway.

function setupTypedSheets() {
  const config = createTypedSheetsConfig_();
  const configJson = JSON.stringify(config, null, 2);

  Logger.log(configJson);

  return config;
}

/**
 * Handles typed-sheets gateway HTTP requests under the document lock.
 *
 * @param {object} e - Apps Script Web App event with the JSON request body.
 * @returns {TextOutput} JSON response for the requested gateway operation.
 */
function doPost(e) {
  try {
    const request = parseRequest_(e);
    const config = getTypedSheetsConfig_();

    if (!config || request.secret !== config.auth.gatewaySecret) {
      return error_("unauthorized", "Invalid gateway secret");
    }

    const operation = validateOperation_(request);
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
      const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

      if (operation === "ping") {
        return json_({
          ok: true,
          locked: true,
          spreadsheetId: spreadsheet.getId(),
          sheetName: spreadsheet.getActiveSheet().getName(),
        });
      }

      if (operation === "initializeSystemSheets") {
        return json_({
          ok: true,
          systemSheets: initializeSystemSheets_(spreadsheet, request),
        });
      }

      if (operation === "enqueueTasks") {
        return json_(enqueueTasks_(spreadsheet, request));
      }

      if (operation === "processTaskQueue") {
        return json_(processTaskQueue_(spreadsheet, request));
      }

      if (operation === "readCanonicalSheet") {
        return json_(readCanonicalSheet_(spreadsheet, request));
      }

      if (operation === "readSheet") {
        return json_(readSheet_(spreadsheet, request));
      }

      // Legacy direct-write operations remain for existing gateway configs
      // until repository writes are fully routed through the task queue.
      if (operation === "ensureSheet") {
        ensureSheet_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "initializeSheet") {
        initializeSheet_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "writeHeader") {
        writeHeader_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "appendRow") {
        appendRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "appendRows") {
        appendRows_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "updateRow") {
        updateRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "updateRowsByKey") {
        return json_(updateRowsByKey_(spreadsheet, request));
      }

      if (operation === "deleteRow") {
        deleteRow_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRows") {
        deleteRows_(spreadsheet, request);
        return json_({ ok: true });
      }

      if (operation === "deleteRowsByKey") {
        return json_(deleteRowsByKey_(spreadsheet, request));
      }

      return error_("unknown_operation", "Unknown operation: " + operation);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return error_(
      error && error.code ? error.code : "internal_error",
      error && error.message ? error.message : String(error),
    );
  }
}
