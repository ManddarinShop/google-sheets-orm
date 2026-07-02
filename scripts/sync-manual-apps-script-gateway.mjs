import { readFile, writeFile } from "node:fs/promises";

const mode = process.argv[2] ?? "check";
const codePath = "templates/manual-apps-script-gateway/Code.gs";
const templatePath = "src/setup/ManualAppsScriptGateway.ts";
const marker = "export const manualAppsScriptGatewayCode = ";
const suffixMarker = "export function createSetupWelcomeMessage";

if (mode !== "check" && mode !== "write") {
  throw new Error("Usage: node scripts/sync-manual-apps-script-gateway.mjs [check|write]");
}

const [code, source] = await Promise.all([
  readFile(codePath, "utf8"),
  readFile(templatePath, "utf8"),
]);

const markerIndex = source.indexOf(marker);
const suffixIndex = source.indexOf(suffixMarker);

if (markerIndex < 0 || suffixIndex < 0 || suffixIndex <= markerIndex) {
  throw new Error(`Could not find gateway template markers in ${templatePath}`);
}

const nextSource = [
  source.slice(0, markerIndex),
  marker,
  "`",
  escapeTemplateLiteral(code),
  "`;\n\n",
  source.slice(suffixIndex),
].join("");

if (mode === "check") {
  if (nextSource !== source) {
    throw new Error(
      `${templatePath} is out of sync with ${codePath}. Run npm run sync:gateway-template.`,
    );
  }
} else {
  await writeFile(templatePath, nextSource);
}

function escapeTemplateLiteral(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
}
