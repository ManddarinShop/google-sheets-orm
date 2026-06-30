import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseTypedSheetsConfig,
  type TypedSheetsConfig,
} from "./Config.js";

export interface LoadTypedSheetsConfigOptions {
  cwd?: string;
  configPath?: string;
}

export async function loadTypedSheetsConfig(
  options?: LoadTypedSheetsConfigOptions,
): Promise<TypedSheetsConfig> {
  const configPath = resolveConfigPath(options);
  const raw = await readConfigFile(configPath);
  const parsed = parseConfigJson(raw);

  return parseTypedSheetsConfig(parsed);
}

function resolveConfigPath(options?: LoadTypedSheetsConfigOptions): string {
  return (
    options?.configPath ??
    join(options?.cwd ?? process.cwd(), ".typed-sheets.json")
  );
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

function parseConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("typed-sheets config file contains invalid JSON");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
