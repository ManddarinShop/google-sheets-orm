import { join } from "node:path";

export interface TypedSheetsConfigPathOptions {
  cwd?: string;
  configPath?: string;
}

/**
 * Resolves the config path: an explicit configPath wins, otherwise
 * .typed-sheets.json is resolved from cwd or the current working directory.
 */
export function resolveTypedSheetsConfigPath(
  options: TypedSheetsConfigPathOptions = {},
): string {
  return (
    options.configPath ?? join(options.cwd ?? process.cwd(), ".typed-sheets.json")
  );
}
