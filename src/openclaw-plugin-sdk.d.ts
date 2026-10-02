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
        info: (message: string) => void;
        warn: (message: string) => void;
      };
    }) => void | Promise<void>;
    stop?: (ctx?: unknown) => void | Promise<void>;
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
        current: () => OpenClawConfig;
        mutateConfigFile: (params: {
          afterWrite?: { mode: "auto" | "restart" | "none"; reason?: string };
          mutate: (draft: OpenClawConfig) => void | Promise<void>;
        }) => Promise<unknown>;
      };
    };
    on: (event: string, handler: (event: any, ctx: any) => void) => void;
  };

  export function onDiagnosticEvent(
    handler: (event: DiagnosticEventPayload) => void,
  ): () => void;

  export function emptyPluginConfigSchema(): unknown;
}

// OpenClaw removed the root `openclaw/plugin-sdk` barrel in its July 2026 SDK sweep. Runtime
// imports must use these subpaths;
// type-only imports of the root module above are erased at build time.
declare module "openclaw/plugin-sdk/core" {
  export { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
}

declare module "openclaw/plugin-sdk/diagnostic-runtime" {
  export { onDiagnosticEvent } from "openclaw/plugin-sdk";
}
