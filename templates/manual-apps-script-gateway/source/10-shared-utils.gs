// Source module for the generated manual Apps Script gateway.

function readHeaderRow_(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    return [];
  }

  return sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(function(value) {
      return String(value);
    });
}

function isHeaderRowEmpty_(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    return true;
  }

  const headerValues = sheet.getRange(1, 1, 1, lastColumn).getValues()[0] || [];

  return isEmptyRow_(headerValues);
}

function isEmptyRow_(row) {
  return row.every(function(value) {
    return value === "" || value === null;
  });
}

function toSheetCell_(value) {
  if (value === "") {
    return null;
  }

  return value;
}

function gatewayError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function error_(code, message) {
  return json_({
    ok: false,
    code: code,
    error: code,
    message: message,
  });
}


function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
