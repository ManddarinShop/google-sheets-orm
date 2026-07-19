import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const sourceDirectory = join(
  repositoryRoot,
  "templates/manual-apps-script-gateway/source",
);
const outputPath = join(
  repositoryRoot,
  "templates/manual-apps-script-gateway/Code.gs",
);

const generatedHeader = `// GENERATED FILE: edit files under source/ and run npm run build:gateway.
// This single file is the copy-and-deploy artifact for the manual Apps Script gateway.

`;

const sourceFiles = (await readdir(sourceDirectory))
  .filter((fileName) => fileName.endsWith(".gs"))
  .sort();

if (sourceFiles.length === 0) {
  throw new Error(`No gateway source files found in ${sourceDirectory}`);
}

const sourceContents = await Promise.all(
  sourceFiles.map(async (fileName) => {
    const filePath = join(sourceDirectory, fileName);
    const contents = await readFile(filePath, "utf8");
    return `// ----- ${fileName} -----\n\n${contents.trim()}\n`;
  }),
);

await writeFile(outputPath, generatedHeader + sourceContents.join("\n"));

console.log(
  `Built ${outputPath} from ${sourceFiles.length} source files: ${sourceFiles.join(", ")}`,
);
