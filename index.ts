import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { registerOpikCli } from "./src/cli.js";
import { createOpikService, type OpikRuntimeService } from "./src/service.js";
import { parseOpikPluginConfig } from "./src/types.js";

const plugin: OpenClawPluginDefinition & {
  register(api: OpenClawPluginApi): void;
} = definePluginEntry({
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
        registerOpikCli({
          program,
          currentConfig: () => api.runtime.config.current() as OpenClawConfig,
          mutateConfig: async (mutate) => {
            await api.runtime.config.mutateConfigFile({
              afterWrite: {
                mode: "none",
                reason: "Opik configuration requires an explicit gateway restart",
              },
              mutate,
            });
          },
        }),
      { commands: ["opik"] },
    );
  },
});

export default plugin;
