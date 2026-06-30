import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTypedSheetsConfig, type TypedSheetsConfig } from "./Config.js";

export interface WriteTypedSheetsConfigOptions {
  cwd?: string;
  configPath?: string;
  config: TypedSheetsConfig;
}

export async function writeTypedSheetsConfig(
  options: WriteTypedSheetsConfigOptions,
): Promise<void> {
  const config = parseTypedSheetsConfig(options.config);
  const configPath =
    options.configPath ??
    join(options.cwd ?? process.cwd(), ".typed-sheets.json");

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
