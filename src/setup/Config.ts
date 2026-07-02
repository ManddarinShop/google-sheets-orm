export type TypedSheetsConfig =
  | {
      spreadsheetUrl: string;
      defaultSheetName: string;
      auth: {
        type: "apps-script-gateway";
        gatewayUrl: string;
        gatewaySecret: string;
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

  switch (value.auth.type) {
    case "apps-script-gateway": {
      if (
        typeof value.auth.gatewayUrl !== "string" ||
        value.auth.gatewayUrl.trim() === ""
      ) {
        throw new Error("auth.gatewayUrl must be a non-empty string");
      }

      if (
        typeof value.auth.gatewaySecret !== "string" ||
        value.auth.gatewaySecret.trim() === ""
      ) {
        throw new Error("auth.gatewaySecret must be a non-empty string");
      }

      return {
        spreadsheetUrl: value.spreadsheetUrl,
        defaultSheetName: value.defaultSheetName,
        auth: {
          type: "apps-script-gateway",
          gatewayUrl: value.auth.gatewayUrl,
          gatewaySecret: value.auth.gatewaySecret,
        },
      };
    }

    case "service-account": {
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

    default:
      throw new Error(
        'auth.type must be "apps-script-gateway" or "service-account"',
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoogleSheetsUrl(value: string): boolean {
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+(?:\/|$)/.test(
    value,
  );
}
