import { writeFile } from "node:fs/promises";
import { parseTypedSheetsConfig, type TypedSheetsConfig } from "./Config.js";
import {
  resolveTypedSheetsConfigPath,
  type TypedSheetsConfigPathOptions,
} from "./ConfigPath.js";

export interface WriteTypedSheetsConfigOptions
  extends TypedSheetsConfigPathOptions {
  config: TypedSheetsConfig;
}

export async function writeTypedSheetsConfig(
  options: WriteTypedSheetsConfigOptions,
): Promise<void> {
  const config = parseTypedSheetsConfig(options.config);
  const configPath = resolveTypedSheetsConfigPath(options);

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
