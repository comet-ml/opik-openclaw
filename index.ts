import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { registerOpikCli } from "./src/cli.js";
import { OPIK_PLUGIN_ID } from "./src/service/constants.js";
import { createOpikService, type OpikRuntimeService } from "./src/service.js";
import { parseOpikPluginConfig } from "./src/types.js";

/**
 * Adapts the runtime config API to the read/write pair the CLI uses. OpenClaw 2026.9 removed
 * loadConfig/writeConfigFile from the plugin runtime. `opik configure` only changes this plugin's
 * entry, so only that entry is written back; the rest of the file is left as the host has it.
 */
export function createConfigDeps(runtimeConfig: OpenClawPluginApi["runtime"]["config"]) {
  type Config = ReturnType<typeof runtimeConfig.current>;
  type PluginsSection = { entries?: Record<string, unknown> };
  return {
    loadConfig: () => runtimeConfig.current(),
    writeConfigFile: async (nextConfig: Config) => {
      const nextEntry = (nextConfig.plugins as PluginsSection | undefined)?.entries?.[OPIK_PLUGIN_ID];
      await runtimeConfig.mutateConfigFile({
        afterWrite: { mode: "auto" },
        mutate(draft) {
          const plugins = ((draft.plugins as PluginsSection | undefined) ??= {});
          const entries = (plugins.entries ??= {});
          entries[OPIK_PLUGIN_ID] = nextEntry;
        },
      });
    },
  };
}

const plugin = {
  id: "opik-openclaw",
  name: "Opik",
  description: "Export LLM traces and spans to Opik for observability",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const pluginConfig = parseOpikPluginConfig(api.pluginConfig);
    const service = createOpikService(api, pluginConfig) as OpikRuntimeService;
    service.registerHooks();
    api.registerService(service);
    api.registerCli(
      ({ program }) =>
        registerOpikCli({ program, ...createConfigDeps(api.runtime.config) }),
      { commands: ["opik"] },
    );
  },
};

export default plugin;
