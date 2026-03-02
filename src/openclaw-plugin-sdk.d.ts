declare module "openclaw/plugin-sdk" {
  export type OpenClawConfig = Record<string, unknown>;

  export type DiagnosticEventPayload = {
    type: string;
    sessionKey?: string;
    costUsd?: number;
    context?: {
      limit?: number;
      used?: number;
    };
    model?: string;
    provider?: string;
    durationMs?: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };

  export type OpenClawPluginService = {
    id: string;
    start: (ctx: {
      config: unknown;
      logger: {
        warn: (message: string) => void;
      };
    }) => void | Promise<void>;
    stop?: () => void | Promise<void>;
  };

  export type OpenClawPluginApi = {
    pluginConfig?: unknown;
    registerService: (service: OpenClawPluginService) => void;
    registerCli: (
      register: (params: { program: any }) => void,
      options?: { commands?: string[] },
    ) => void;
    runtime: {
      config: {
        loadConfig: () => OpenClawConfig;
        writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
      };
    };
    on: (event: string, handler: (event: any, ctx: any) => void) => void;
  };

  export function onDiagnosticEvent(
    handler: (event: DiagnosticEventPayload) => void,
  ): () => void;

  export function emptyPluginConfigSchema(): unknown;
}
