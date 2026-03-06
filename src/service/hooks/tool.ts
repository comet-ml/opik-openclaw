import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Opik, Span, Trace } from "opik";
import type { ActiveTrace } from "../../types.js";
import { asNonEmptyString, resolveRunId, resolveToolCallId } from "../helpers.js";
import { sanitizeStringForOpik, sanitizeValueForOpik } from "../payload-sanitizer.js";

type ToolHooksDeps = {
  api: OpenClawPluginApi;
  getClient: () => Opik | null;
  activeTraces: Map<string, ActiveTrace>;
  sessionByAgentId: Map<string, string>;
  getLastActiveSessionKey: () => string | undefined;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  resolveSessionSpanContainer: (
    sessionKey: string,
  ) => { sessionKey: string; active: ActiveTrace; parent: Trace | Span } | undefined;
  warnMissingAfterToolSessionKey: (fallbackMode: string) => void;
  nextSpanSeq: () => number;
  safeSpanUpdate: (span: Span, payload: Record<string, unknown>, reason: string) => void;
  safeSpanEnd: (span: Span, reason: string) => void;
  scheduleMediaAttachmentUploads: (params: {
    entityType: "trace" | "span";
    entity: unknown;
    projectName: string;
    reason: string;
    payloads: unknown[];
  }) => void;
  projectName: string;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export function registerToolHooks(deps: ToolHooksDeps): void {
  deps.api.on("before_tool_call", (event, toolCtx) => {
    if (!deps.getClient()) return;
    const sessionKey = toolCtx.sessionKey;
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, toolCtx.agentId);

    const container = deps.resolveSessionSpanContainer(sessionKey);
    if (!container) return;
    const active = container.active;

    active.lastActivityAt = Date.now();

    const eventObj = event as Record<string, unknown>;
    const ctxObj = toolCtx as Record<string, unknown>;
    const runId = resolveRunId(eventObj, ctxObj);
    const toolCallId = resolveToolCallId(eventObj, ctxObj);
    const sessionId = asNonEmptyString(ctxObj.sessionId);

    const spanMetadata: Record<string, unknown> = {
      ...(toolCtx.agentId ? { agentId: toolCtx.agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    };

    let toolSpan: Span;
    try {
      toolSpan = container.parent.span({
        name: event.toolName,
        type: "tool",
        input: sanitizeValueForOpik(event.params) as any,
        ...(Object.keys(spanMetadata).length > 0 ? { metadata: spanMetadata } : {}),
      });
    } catch (err) {
      deps.warn(
        `opik: tool span creation failed (sessionKey=${sessionKey}, tool=${event.toolName}): ${deps.formatError(err)}`,
      );
      return;
    }

    const spanKey = toolCallId
      ? `session:${sessionKey}:toolcall:${toolCallId}`
      : `session:${sessionKey}:${event.toolName}:${deps.nextSpanSeq()}`;
    if (toolCallId) {
      const existing = active.toolSpans.get(spanKey);
      if (existing) {
        deps.safeSpanEnd(
          existing,
          `replace duplicate toolCallId sessionKey=${sessionKey} toolCallId=${toolCallId}`,
        );
        active.toolSpans.delete(spanKey);
      }
    }
    active.toolSpans.set(spanKey, toolSpan);

    deps.scheduleMediaAttachmentUploads({
      entityType: "span",
      entity: toolSpan,
      projectName: deps.projectName,
      reason: `before_tool_call sessionKey=${sessionKey} tool=${event.toolName}`,
      payloads: [event.params],
    });
  });

  deps.api.on("after_tool_call", (event, toolCtx) => {
    if (!deps.getClient()) return;
    const eventObj = event as Record<string, unknown>;
    const ctxObj = toolCtx as Record<string, unknown>;
    const runId = resolveRunId(eventObj, ctxObj);
    const toolCallId = resolveToolCallId(eventObj, ctxObj);
    const sessionId = asNonEmptyString(ctxObj.sessionId);

    let sessionKey = toolCtx.sessionKey;
    let fallbackMode: "agentId" | "single active trace" | "last active session" | undefined;
    if (!sessionKey) {
      if (typeof toolCtx.agentId === "string" && toolCtx.agentId.length > 0) {
        const byAgentId = deps.sessionByAgentId.get(toolCtx.agentId);
        if (byAgentId && deps.activeTraces.has(byAgentId)) {
          sessionKey = byAgentId;
          fallbackMode = "agentId";
        }
      }
      if (!sessionKey && deps.activeTraces.size === 1) {
        sessionKey = deps.activeTraces.keys().next().value as string | undefined;
        fallbackMode = "single active trace";
      } else if (!sessionKey) {
        const lastActiveSessionKey = deps.getLastActiveSessionKey();
        if (lastActiveSessionKey && deps.activeTraces.has(lastActiveSessionKey)) {
          sessionKey = lastActiveSessionKey;
          fallbackMode = "last active session";
        }
      }
      if (sessionKey && fallbackMode) {
        deps.warnMissingAfterToolSessionKey(fallbackMode);
      }
    }
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, toolCtx.agentId);

    const container = deps.resolveSessionSpanContainer(sessionKey);
    if (!container) return;
    const active = container.active;

    active.lastActivityAt = Date.now();

    let matchedKey: string | undefined;
    let matchedSpan: Span | undefined;
    if (toolCallId) {
      const toolCallKey = `session:${sessionKey}:toolcall:${toolCallId}`;
      const toolCallSpan = active.toolSpans.get(toolCallKey);
      if (toolCallSpan) {
        matchedKey = toolCallKey;
        matchedSpan = toolCallSpan;
      }
    }
    if (!matchedSpan) {
      for (const [key, span] of active.toolSpans) {
        if (key.startsWith(`session:${sessionKey}:${event.toolName}:`)) {
          matchedKey = key;
          matchedSpan = span;
          break;
        }
      }
    }
    if (!matchedKey || !matchedSpan) return;

    const spanUpdate: Record<string, unknown> = {};
    if (event.params && typeof event.params === "object" && !Array.isArray(event.params)) {
      spanUpdate.input = sanitizeValueForOpik(event.params) as Record<string, unknown>;
    }
    const spanMetadata: Record<string, unknown> = {
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(toolCtx.agentId ? { agentId: toolCtx.agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    };
    if (Object.keys(spanMetadata).length > 0) {
      spanUpdate.metadata = spanMetadata;
    }

    if (event.error) {
      const sanitizedError = sanitizeStringForOpik(event.error);
      spanUpdate.output = { error: sanitizedError };
      spanUpdate.errorInfo = {
        exceptionType: "ToolError",
        message: sanitizedError,
        traceback: sanitizedError,
      };
    } else if (event.result !== undefined) {
      const output =
        typeof event.result === "object" && event.result !== null
          ? (event.result as Record<string, unknown>)
          : { result: event.result };
      spanUpdate.output = sanitizeValueForOpik(output) as Record<string, unknown>;
    }

    if (Object.keys(spanUpdate).length > 0) {
      deps.safeSpanUpdate(
        matchedSpan,
        spanUpdate,
        `after_tool_call sessionKey=${sessionKey} tool=${event.toolName}`,
      );
    }

    deps.scheduleMediaAttachmentUploads({
      entityType: "span",
      entity: matchedSpan,
      projectName: deps.projectName,
      reason: `after_tool_call sessionKey=${sessionKey} tool=${event.toolName}`,
      payloads: [event.params, event.result, event.error],
    });

    deps.safeSpanEnd(
      matchedSpan,
      `after_tool_call sessionKey=${sessionKey} tool=${event.toolName} key=${matchedKey}`,
    );
    active.toolSpans.delete(matchedKey);
  });
}
