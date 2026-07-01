#!/usr/bin/env node

import { runSetup, type SetupPrompt } from "../setup/Setup.js";
import { createInquirerSetupPrompt } from "../setup/InquirerSetupPrompt.js";

export interface CliDeps {
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  createSetupPrompt(): SetupPrompt;
  runSetup(options: {
    cwd?: string;
    prompt: SetupPrompt;
  }): Promise<void>;
}

export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  const command = args[0];

  if (command !== "setup") {
    deps.stderr.write("Usage: typed-sheets setup\n");
    return 1;
  }

  try {
    await deps.runSetup({
      cwd: deps.cwd,
      prompt: deps.createSetupPrompt(),
    });

    return 0;
  } catch (error) {
    deps.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
if (isMainModule()) {
  const exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    createSetupPrompt: createInquirerSetupPrompt,
    runSetup,
  });

  process.exit(exitCode);
}

function isMainModule(): boolean {
  return import.meta.url === `file://${process.argv[1]}`;
}
