import fs from "node:fs";
import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";

const emptyPluginConfigSchema = vi.hoisted(() =>
  vi.fn(() => ({
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
    parse: (value: unknown) => value,
  })),
);

vi.mock("opik", () => ({
  disableLogger: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  emptyPluginConfigSchema,
}));

import plugin, { createConfigDeps } from "../index.js";

describe("plugin smoke", () => {
  test("registers service and CLI commands", () => {
    const registerService = vi.fn();
    const registerCli = vi.fn();
    const on = vi.fn();

    plugin.register({
      pluginConfig: { enabled: true },
      on,
      registerService,
      registerCli,
      runtime: {
        config: {
          current: () => ({}),
          mutateConfigFile: async () => undefined,
        },
      },
    } as any);

    expect(registerService).toHaveBeenCalledTimes(1);
    expect(registerService.mock.calls[0]?.[0]?.id).toBe("opik-openclaw");
    expect(on).toHaveBeenCalledWith("llm_input", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));

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

    expect(manifest.id).toBe("opik-openclaw");
    expect(manifest.activation?.onStartup).toBe(true);
    expect(manifest.configSchema?.properties?.apiKey?.type).toBe("string");
    expect(manifest.configSchema?.properties?.projectName?.type).toBe("string");
    expect(manifest.uiHints?.apiKey?.sensitive).toBe(true);
  });

  test("package declares zod runtime dependency for packaged installs", () => {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    expect(packageJson.dependencies?.zod).toBeTruthy();
  });

  test("package declares built runtime entry for installed OpenClaw loads", () => {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    expect(packageJson.openclaw?.extensions).toEqual(["./index.ts"]);
    expect(packageJson.openclaw?.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(packageJson.openclaw?.compat?.pluginApi).toBeTruthy();
    expect(packageJson.openclaw?.build?.openclawVersion).toBeTruthy();
    expect(packageJson.files).toContain("dist/**");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
  });
});

describe("createConfigDeps", () => {
  test("reads the current config and writes back only the Opik plugin entry", async () => {
    const current = { gateway: { port: 1 }, plugins: { entries: {} } };
    const draft: Record<string, any> = {
      gateway: { port: 2 },
      plugins: { allow: ["other"], entries: { other: { enabled: true } } },
    };
    const mutateConfigFile = vi.fn(async (params: { afterWrite?: unknown; mutate: (d: any) => void }) => {
      params.mutate(draft);
    });
    const deps = createConfigDeps({ current: () => current, mutateConfigFile } as any);

    expect(deps.loadConfig()).toBe(current);

    const next = {
      gateway: { port: 99 },
      plugins: { allow: [], entries: { "opik-openclaw": { enabled: true }, other: { enabled: false } } },
    };
    await deps.writeConfigFile(next as any);

    expect(mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ afterWrite: { mode: "auto" } }),
    );
    // Only the Opik entry changes; other plugins and the rest of the file stay as the host has them.
    expect(draft).toEqual({
      gateway: { port: 2 },
      plugins: { allow: ["other"], entries: { other: { enabled: true }, "opik-openclaw": { enabled: true } } },
    });
  });
});
