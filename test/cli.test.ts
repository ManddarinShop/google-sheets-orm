import { describe, expect, it } from "vitest";
import { main, renderSetupGuide } from "../src/cli/Cli.js";

describe("beta setup CLI", () => {
  it("prints the packaged gateway copy command", () => {
    const output = renderSetupGuide();

    expect(output).toContain("pbcopy < node_modules/typed-sheets/apps-script/gateway/Code.gs");
    expect(output).toContain("node_modules/typed-sheets/apps-script/gateway/appsscript.json");
    expect(output).toContain("runSyncGatewaySelfTest");
  });

  it("accepts setup and help, and rejects unknown commands", () => {
    expect(main(["setup"])).toBe(0);
    expect(main(["--help"])).toBe(0);
    expect(main(["unknown"])).toBe(1);
  });
});
