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

  export type CodexAppServerToolResultEvent = {
    threadId: string;
    turnId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
  };

  export type CodexAppServerExtensionContext = {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
  };

  export type CodexAppServerExtensionRuntime = {
    on: (
      event: "tool_result",
      handler: (
        event: CodexAppServerToolResultEvent,
        ctx: CodexAppServerExtensionContext,
      ) => void | Promise<void>,
    ) => void;
  };

  export type CodexAppServerExtensionFactory = (
    runtime: CodexAppServerExtensionRuntime,
  ) => void | Promise<void>;

  export type OpenClawPluginApi = {
    pluginConfig?: unknown;
    registerService: (service: OpenClawPluginService) => void;
    registerCli: (
      register: (params: { program: any }) => void,
      options?: { commands?: string[] },
    ) => void;
    registerCodexAppServerExtensionFactory?: (factory: CodexAppServerExtensionFactory) => void;
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
