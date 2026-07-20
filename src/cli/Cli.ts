#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gatewaySourceRelativePath = "node_modules/typed-sheets/apps-script/gateway/Code.gs";
const gatewayManifestRelativePath = "node_modules/typed-sheets/apps-script/gateway/appsscript.json";

/** Returns the small, non-interactive setup guide shipped with the beta CLI. */
export function renderSetupGuide(root: string = packageRoot): string {
  const gatewaySource = resolve(root, "apps-script/gateway/Code.gs");
  const gatewayManifest = resolve(root, "apps-script/gateway/appsscript.json");
  if (!existsSync(gatewaySource) || !existsSync(gatewayManifest)) {
    throw new Error("typed-sheets gateway assets are missing from this package");
  }

  return [
    "typed-sheets beta setup",
    "",
    "Apps Script source:",
    `  ${gatewaySourceRelativePath}`,
    "",
    "macOS copy command:",
    `  pbcopy < ${gatewaySourceRelativePath}`,
    "",
    "Apps Script manifest:",
    `  ${gatewayManifestRelativePath}`,
    "",
    "Next:",
    "  1. Paste Code.gs into the Apps Script project.",
    "  2. Copy appsscript.json into the Apps Script manifest.",
    "  3. Run runSyncGatewaySelfTest in Apps Script.",
    "  4. Deploy the project as a Web app and configure the service URL/secret.",
  ].join("\n");
}

/** Runs the intentionally narrow setup command and returns a process exit code. */
export function main(args: readonly string[] = process.argv.slice(2)): number {
  const command = args[0] ?? "help";
  if (command === "setup") {
    try {
      process.stdout.write(`${renderSetupGuide()}\n`);
      return 0;
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  process.stdout.write([
    "Usage: typed-sheets setup",
    "",
    "Print the packaged Apps Script gateway paths and copy command.",
  ].join("\n") + "\n");
  return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? null : realpathSync(resolve(process.argv[1]));
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath !== null && invokedPath === modulePath) {
  process.exitCode = main();
}
