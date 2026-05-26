import type {
  CodexAppServerExtensionContext,
  CodexAppServerToolResultEvent,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import type { Opik, Span, Trace } from "opik";
import type { ActiveTrace } from "../../types.js";
import { sanitizeStringForOpik, sanitizeValueForOpik } from "../payload-sanitizer.js";

type CodexHooksDeps = {
  api: OpenClawPluginApi;
  getClient: () => Opik | null;
  activeTraces: Map<string, ActiveTrace>;
  sessionByAgentId: Map<string, string>;
  getLastActiveSessionKey: () => string | undefined;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  resolveSessionSpanContainer: (
    sessionKey: string,
  ) => { sessionKey: string; active: ActiveTrace; parent: Trace | Span } | undefined;
  safeSpanEnd: (span: Span, reason: string) => void;
  scheduleMediaAttachmentUploads: (params: {
    entityType: "trace" | "span";
    entity: unknown;
    projectName: string;
    reason: string;
    payloads: unknown[];
  }) => void;
  getProjectName: () => string;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export function registerCodexHooks(deps: CodexHooksDeps): void {
  const register = deps.api.registerCodexAppServerExtensionFactory;
  if (typeof register !== "function") {
    return;
  }

  register((runtime) => {
    runtime.on("tool_result", (event, ctx) => {
      handleCodexToolResult(deps, event, ctx);
    });
  });
}

function handleCodexToolResult(
  deps: CodexHooksDeps,
  event: CodexAppServerToolResultEvent,
  ctx: CodexAppServerExtensionContext,
): void {
  if (!deps.getClient()) return;

  const sessionKey = resolveSessionKey(deps, ctx);
  if (!sessionKey) return;
  deps.rememberSessionCorrelation(sessionKey, ctx.agentId);

  const container = deps.resolveSessionSpanContainer(sessionKey);
  if (!container) return;
  const active = container.active;
  const parent = active.llmSpan ?? container.parent;

  active.lastActivityAt = Date.now();

  const { output, errorInfo } = extractResult(event.result);

  const metadata: Record<string, unknown> = {
    source: "codex_app_server",
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
  };

  const spanPayload: Record<string, unknown> = {
    name: event.toolName,
    type: "tool",
    input: sanitizeValueForOpik(event.args),
    ...(output !== undefined ? { output } : {}),
    ...(errorInfo ? { errorInfo } : {}),
    metadata,
  };

  let toolSpan: Span;
  try {
    toolSpan = parent.span(spanPayload as any);
  } catch (err) {
    deps.warn(
      `opik: codex tool span creation failed (sessionKey=${sessionKey}, tool=${event.toolName}): ${deps.formatError(err)}`,
    );
    return;
  }

  deps.scheduleMediaAttachmentUploads({
    entityType: "span",
    entity: toolSpan,
    projectName: deps.getProjectName(),
    reason: `codex_app_server.tool_result sessionKey=${sessionKey} tool=${event.toolName}`,
    payloads: [event.args, event.result],
  });

  deps.safeSpanEnd(
    toolSpan,
    `codex_app_server.tool_result sessionKey=${sessionKey} tool=${event.toolName} toolCallId=${event.toolCallId}`,
  );
}

function resolveSessionKey(
  deps: CodexHooksDeps,
  ctx: CodexAppServerExtensionContext,
): string | undefined {
  if (ctx.sessionKey && deps.activeTraces.has(ctx.sessionKey)) {
    return ctx.sessionKey;
  }
  if (ctx.sessionId && deps.activeTraces.has(ctx.sessionId)) {
    return ctx.sessionId;
  }
  if (ctx.agentId) {
    const byAgentId = deps.sessionByAgentId.get(ctx.agentId);
    if (byAgentId && deps.activeTraces.has(byAgentId)) {
      return byAgentId;
    }
  }
  if (deps.activeTraces.size === 1) {
    return deps.activeTraces.keys().next().value as string | undefined;
  }
  const last = deps.getLastActiveSessionKey();
  if (last && deps.activeTraces.has(last)) {
    return last;
  }
  return undefined;
}

type CodexErrorInfo = {
  exceptionType: string;
  message: string;
  traceback: string;
};

function extractResult(
  result: unknown,
): { output?: Record<string, unknown>; errorInfo?: CodexErrorInfo } {
  if (result === undefined || result === null) {
    return {};
  }

  if (typeof result === "object" && !Array.isArray(result)) {
    const resultObj = result as Record<string, unknown>;
    const errorField = resultObj.error;
    if (typeof errorField === "string" && errorField.length > 0) {
      const sanitized = sanitizeStringForOpik(errorField);
      return {
        output: { error: sanitized },
        errorInfo: {
          exceptionType: "CodexToolError",
          message: sanitized,
          traceback: sanitized,
        },
      };
    }
    return { output: sanitizeValueForOpik(resultObj) as Record<string, unknown> };
  }

  return { output: { result: sanitizeValueForOpik(result) } };
}
