export type TypedSheetsConfig =
  | {
      spreadsheetUrl: string;
      defaultSheetName: string;
      auth: {
        type: "oauth";
        tokenFile: string;
      };
    }
  | {
      spreadsheetUrl: string;
      defaultSheetName: string;
      auth: {
        type: "service-account";
        credentialsFile: string;
      };
    };

export function parseTypedSheetsConfig(value: unknown): TypedSheetsConfig {
  if (!isRecord(value)) {
    throw new Error("config must be an object");
  }

  if (
    typeof value.spreadsheetUrl !== "string" ||
    !isGoogleSheetsUrl(value.spreadsheetUrl)
  ) {
    throw new Error("spreadsheetUrl must be a Google Sheets URL");
  }

  if (
    typeof value.defaultSheetName !== "string" ||
    value.defaultSheetName.trim() === ""
  ) {
    throw new Error("defaultSheetName must be a non-empty string");
  }

  if (!isRecord(value.auth)) {
    throw new Error("auth must be an object");
  }

  if (value.auth.type === "oauth") {

    if (typeof value.auth.tokenFile !== "string" || value.auth.tokenFile.trim() === "") { 
      throw new Error("auth.tokenFile must be a non-empty string");
    }

    return {
      spreadsheetUrl: value.spreadsheetUrl,
      defaultSheetName: value.defaultSheetName,
      auth: {
        type: "oauth",
        tokenFile: value.auth.tokenFile
      },
    };
  }

  if (value.auth.type === "service-account") {
    if (
      typeof value.auth.credentialsFile !== "string" ||
      value.auth.credentialsFile.trim() === ""
    ) {
      throw new Error("auth.credentialsFile must be a non-empty string");
    }

    return {
      spreadsheetUrl: value.spreadsheetUrl,
      defaultSheetName: value.defaultSheetName,
      auth: {
        type: "service-account",
        credentialsFile: value.auth.credentialsFile,
      },
    };
  }

  throw new Error('auth.type must be "oauth" or "service-account"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoogleSheetsUrl(value: string): boolean {
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+(?:\/|$)/.test(
    value,
  );
}
