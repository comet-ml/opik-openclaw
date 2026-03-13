import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import {
  getOpikPluginEntry,
  getApiKeyHelpText,
  registerOpikCli,
  setOpikPluginEntry,
  showOpikStatus,
} from "./configure.js";

describe("configure helpers", () => {
  test("setOpikPluginEntry writes plugins.entries.opik-openclaw", () => {
    const next = setOpikPluginEntry(
      {} as any,
      {
        enabled: true,
        apiKey: "test-key",
        apiUrl: "https://opik.example.com",
        projectName: "test-project",
        workspaceName: "test-workspace",
        tags: ["tag-a", "tag-b"],
      },
      true,
    ) as any;

    expect(next.plugins.entries["opik-openclaw"].enabled).toBe(true);
    expect(next.plugins.entries["opik-openclaw"].config).toEqual({
      enabled: true,
      apiKey: "test-key",
      apiUrl: "https://opik.example.com",
      projectName: "test-project",
      workspaceName: "test-workspace",
      tags: ["tag-a", "tag-b"],
    });
  });

  test("getOpikPluginEntry reads canonical plugin-scoped config", () => {
    const parsed = getOpikPluginEntry({
      plugins: {
        entries: {
          "opik-openclaw": {
            enabled: false,
            config: {
              projectName: "project-x",
            },
          },
        },
      },
    } as any);

    expect(parsed.enabled).toBe(false);
    expect(parsed.config.projectName).toBe("project-x");
  });

  test("getApiKeyHelpText includes free signup guidance for cloud", () => {
    expect(getApiKeyHelpText("cloud", "https://www.comet.com/")).toEqual([
      "You can find your Opik API key here:\nhttps://www.comet.com/account-settings/apiKeys",
      "No Opik Cloud account yet? Sign up for a free account:\nhttps://www.comet.com/signup?from=llm",
    ]);
  });

  test("getApiKeyHelpText omits cloud signup guidance for self-hosted", () => {
    expect(getApiKeyHelpText("self-hosted", "https://opik.example.com/")).toEqual([
      "You can find your Opik API key here:\nhttps://opik.example.com/account-settings/apiKeys",
    ]);
  });
});

describe("opik status command", () => {
  test("reads plugin entry and masks api key", async () => {
    const program = new Command();
    const loadConfig = () =>
      ({
        plugins: {
          entries: {
            "opik-openclaw": {
              enabled: true,
              config: {
                enabled: true,
                apiUrl: "https://opik.example.com",
                projectName: "demo",
                workspaceName: "default",
                apiKey: "secret-key",
                tags: ["prod"],
              },
            },
          },
        },
      }) as any;

    registerOpikCli({
      program, // keep a smoke-level check that command registration still succeeds
      loadConfig,
      writeConfigFile: async () => undefined,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    showOpikStatus({
      loadConfig,
      writeConfigFile: async () => undefined,
    });
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    logSpy.mockRestore();
    expect(output).toContain("Enabled:    yes");
    expect(output).toContain("API key:    ***");
    expect(output).not.toContain("secret-key");
  });

  test("status command is registered under openclaw opik", () => {
    const program = new Command();
    registerOpikCli({
      program,
      loadConfig: () =>
        ({
          plugins: {
            entries: {
              "opik-openclaw": {
                enabled: true,
                config: {
                  enabled: true,
                  apiUrl: "https://opik.example.com",
                  projectName: "demo",
                  workspaceName: "default",
                  apiKey: "secret-key",
                  tags: ["prod"],
                },
              },
            },
          },
        }) as any,
      writeConfigFile: async () => undefined,
    });
    const opikCommand = program.commands.find((cmd) => cmd.name() === "opik");
    expect(opikCommand).toBeDefined();
    expect(opikCommand?.commands.map((cmd) => cmd.name())).toContain("status");
  });
});
