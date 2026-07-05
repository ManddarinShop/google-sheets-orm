import { readFile } from "node:fs/promises";
import {
  parseTypedSheetsConfig,
  type TypedSheetsConfig,
} from "./Config.js";
import {
  resolveTypedSheetsConfigPath,
  type TypedSheetsConfigPathOptions,
} from "./ConfigPath.js";

export interface LoadTypedSheetsConfigOptions
  extends TypedSheetsConfigPathOptions {}

export async function loadTypedSheetsConfig(
  options: LoadTypedSheetsConfigOptions = {},
): Promise<TypedSheetsConfig> {
  const configPath = resolveTypedSheetsConfigPath(options);
  const raw = await readConfigFile(configPath);
  const parsed = requireConfigJson(raw);

  return parseTypedSheetsConfig(parsed);
}

async function readConfigFile(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("typed-sheets config file was not found");
    }

    throw error;
  }
}

function requireConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("typed-sheets config file contains invalid JSON");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
