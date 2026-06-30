import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadOAuthTokenFile, parseOAuthTokenFile } from "../src/setup/OAuthToken.js";

describe("OAuth token file", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "typed-sheets-oauth-token-"));
    tempDirs.push(dir);
    return dir;
  }

  it("parses a token file with a refresh token", () => {
    expect(
      parseOAuthTokenFile({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: 1_800_000_000_000,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        token_type: "Bearer",
      }),
    ).toEqual({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expiry_date: 1_800_000_000_000,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      token_type: "Bearer",
    });
  });

  it("rejects token files without a refresh token", () => {
    expect(() =>
      parseOAuthTokenFile({
        access_token: "access-token",
        expiry_date: 1_800_000_000_000,
        token_type: "Bearer",
      }),
    ).toThrow(/OAuth token file must include refresh_token/);
  });

  it("loads a token file from disk", async () => {
    const dir = await createTempDir();
    const tokenFile = join(dir, "token.json");

    await writeFile(
      tokenFile,
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: 1_800_000_000_000,
        token_type: "Bearer",
      }),
    );

    await expect(loadOAuthTokenFile(tokenFile)).resolves.toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expiry_date: 1_800_000_000_000,
      token_type: "Bearer",
    });
  });

  it("rejects invalid token JSON", async () => {
    const dir = await createTempDir();
    const tokenFile = join(dir, "token.json");

    await writeFile(tokenFile, "{ invalid json");

    await expect(loadOAuthTokenFile(tokenFile)).rejects.toThrow(
      /OAuth token file contains invalid JSON/,
    );
  });
});
