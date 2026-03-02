import fs from "node:fs";
import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";

vi.mock("opik", () => ({
  disableLogger: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: () => ({
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
    parse: (value: unknown) => value,
  }),
}));

import plugin from "../index.js";

describe("plugin smoke", () => {
  test("registers service and CLI commands", () => {
    const registerService = vi.fn();
    const registerCli = vi.fn();

    plugin.register({
      pluginConfig: { enabled: true },
      registerService,
      registerCli,
      runtime: {
        config: {
          loadConfig: () => ({}),
          writeConfigFile: async () => undefined,
        },
      },
    } as any);

    expect(registerService).toHaveBeenCalledTimes(1);
    expect(registerService.mock.calls[0]?.[0]?.id).toBe("opik");

    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toEqual({ commands: ["opik"] });

    const registrar = registerCli.mock.calls[0]?.[0];
    const program = new Command();
    registrar({ program });

    const opikCommand = program.commands.find((cmd) => cmd.name() === "opik");
    expect(opikCommand).toBeDefined();
    expect(opikCommand?.commands.map((cmd) => cmd.name())).toEqual(
      expect.arrayContaining(["configure", "status"]),
    );
  });

  test("manifest exposes expected config schema and ui hints", () => {
    const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(manifest.id).toBe("opik");
    expect(manifest.configSchema?.properties?.apiKey?.type).toBe("string");
    expect(manifest.configSchema?.properties?.projectName?.type).toBe("string");
    expect(manifest.uiHints?.apiKey?.sensitive).toBe(true);
  });
});
