import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { registerOpikCli } from "./src/cli.js";
import { createOpikService, type OpikRuntimeService } from "./src/service.js";
import { parseOpikPluginConfig } from "./src/types.js";

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
        registerOpikCli({
          program,
          loadConfig: api.runtime.config.loadConfig,
          writeConfigFile: api.runtime.config.writeConfigFile,
        }),
      { commands: ["opik"] },
    );
  },
};

export default plugin;
