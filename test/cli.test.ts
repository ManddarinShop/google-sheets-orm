import { describe, expect, it, vi } from "vitest";

describe("CLI setup command", () => {
  it("detects bin symlink execution as the main module", async () => {
    const { mkdtemp, symlink, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { isMainModule } = await import("../src/cli/Cli.js");

    const dir = await mkdtemp(join(tmpdir(), "typed-sheets-cli-"));

    try {
      const target = join(dir, "Cli.js");
      const link = join(dir, "typed-sheets");

      await writeFile(target, "");
      await symlink(target, link);

      expect(isMainModule(pathToFileURL(target).href, link)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wires the setup command to prompt and runSetup", async () => {
    const { runCli } = await import("../src/cli/Cli.js");
    const prompt = { kind: "prompt" };
    const calls: unknown[] = [];

    const exitCode = await runCli(["setup"], {
      cwd: "/project",
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      createSetupPrompt: () => {
        calls.push("createSetupPrompt");
        return prompt;
      },
      runSetup: async (options: unknown) => {
        calls.push(options);
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      "createSetupPrompt",
      {
        cwd: "/project",
        prompt,
      },
    ]);
  });

  it("prints usage and returns 1 for unknown commands", async () => {
    const { runCli } = await import("../src/cli/Cli.js");
    const stderr = { write: vi.fn() };

    const exitCode = await runCli(["unknown"], {
      cwd: "/project",
      stdout: { write: vi.fn() },
      stderr,
      createSetupPrompt: () => {
        throw new Error("should not create prompt");
      },
      runSetup: async () => {
        throw new Error("should not run setup");
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith("Usage: typed-sheets setup\n");
  });

  it("prints setup errors and returns 1", async () => {
    const { runCli } = await import("../src/cli/Cli.js");
    const stderr = { write: vi.fn() };

    const exitCode = await runCli(["setup"], {
      cwd: "/project",
      stdout: { write: vi.fn() },
      stderr,
      createSetupPrompt: () => ({}),
      runSetup: async () => {
        throw new Error("setup failed");
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith("setup failed\n");
  });
});
