import { readFile } from "node:fs/promises";

export interface OAuthTokenFile {
  access_token?: string;
  refresh_token: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

export function parseOAuthTokenFile(value: unknown): OAuthTokenFile {
  if (!isRecord(value)) {
    throw new Error("OAuth token file must be an object");
  }

  if (
    typeof value.refresh_token !== "string" ||
    value.refresh_token.trim() === ""
  ) {
    throw new Error("OAuth token file must include refresh_token");
  }

  const token: OAuthTokenFile = {
    refresh_token: value.refresh_token,
  };

  if (typeof value.access_token === "string") {
    token.access_token = value.access_token;
  }

  if (typeof value.expiry_date === "number") {
    token.expiry_date = value.expiry_date;
  }

  if (typeof value.scope === "string") {
    token.scope = value.scope;
  }

  if (typeof value.token_type === "string") {
    token.token_type = value.token_type;
  }

  return token;
}

export async function loadOAuthTokenFile(
  tokenFile: string,
): Promise<OAuthTokenFile> {
  const raw = await readFile(tokenFile, "utf8");

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OAuth token file contains invalid JSON");
  }

  return parseOAuthTokenFile(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
