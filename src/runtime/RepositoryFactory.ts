import { auth as googleAuth } from "@googleapis/sheets";
import type { SheetAdapter } from "../adapter/Adapter.js";
import { GoogleSheetsAdapter } from "../adapter/GoogleSheetsAdapter.js";
import {
  createSheetRepository,
  type ColumnMap,
  type SheetRepository,
} from "../core/Repository.js";
import { loadTypedSheetsConfig } from "../setup/ConfigLoader.js";
import type { TypedSheetsConfig } from "../setup/Config.js";

export interface CreateRepositoryFromConfigOptions<
  T extends Record<string, unknown>,
> {
  cwd?: string;
  configPath?: string;
  key: keyof T & string;
  columns: ColumnMap<T>;
  createAdapter?: (
    config: TypedSheetsConfig,
  ) => SheetAdapter | Promise<SheetAdapter>;
}

export async function createRepositoryFromConfig<
  T extends Record<string, unknown>,
    >(options: CreateRepositoryFromConfigOptions<T>): Promise<SheetRepository<T>> {
  let config: TypedSheetsConfig;

  if (options.cwd !== undefined && options.configPath !== undefined) {
    config = await loadTypedSheetsConfig({
      cwd: options.cwd,
      configPath: options.configPath,
    });
  } else if (options.cwd !== undefined) {
    config = await loadTypedSheetsConfig({ cwd: options.cwd });
  } else if (options.configPath !== undefined) {
    config = await loadTypedSheetsConfig({ configPath: options.configPath });
  } else {
    config = await loadTypedSheetsConfig();
  }

  const adapter = options.createAdapter
    ? await options.createAdapter(config)
    : createAdapterFromConfig(config);

  return createSheetRepository({
    adapter,
    sheetName: config.defaultSheetName,
    key: options.key,
    columns: options.columns,
  });
}

function createAdapterFromConfig(config: TypedSheetsConfig): SheetAdapter {
  if (config.auth.type === "apps-script-gateway") {
    throw new Error(
      "Apps Script gateway runtime adapter is not implemented yet",
    );
  }

  const auth = new googleAuth.GoogleAuth({
    keyFile: config.auth.credentialsFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return new GoogleSheetsAdapter({
    spreadsheetUrl: config.spreadsheetUrl,
    auth,
  });
}
