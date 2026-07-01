function setupTypedSheetsSheetInfo() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = spreadsheet.getActiveSheet();

  const info = {
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    defaultSheetName: activeSheet.getName(),
  };

  Logger.log(JSON.stringify(info, null, 2));

  return info;
}
