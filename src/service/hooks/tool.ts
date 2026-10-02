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
  resolveSessionSpanContainer: (sessionKey: string) => SessionSpanContainer | undefined;
  warnMissingAfterToolSessionKey: (fallbackMode: SessionFallbackMode) => void;
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
  getProjectName: () => string;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export type SessionFallbackMode = "agentId" | "single active trace" | "last active session";

type SessionSpanContainer = { sessionKey: string; active: ActiveTrace; parent: Trace | Span };

// Bounds the skipped-call record if after_tool_call never arrives for some of them, and drops
// entries old enough that a matching after_tool_call would be a different, reused call id.
const MAX_SKIPPED_TOOL_CALLS = 500;
const SKIPPED_TOOL_CALL_TTL_MS = 5 * 60 * 1000;

/**
 * Finds the session a tool call belongs to when OpenClaw leaves `sessionKey` out of the hook
 * context (it does for bundle-MCP tools in before_tool_call). `allowLastActive` permits the
 * last-active-session guess, which can pick the wrong session when several run at once.
 */
function resolveToolSessionKey(
  deps: ToolHooksDeps,
  toolCtx: { sessionKey?: string; agentId?: string },
  { allowLastActive }: { allowLastActive: boolean },
): { sessionKey?: string; fallbackMode?: SessionFallbackMode } {
  if (toolCtx.sessionKey) return { sessionKey: toolCtx.sessionKey };
  if (typeof toolCtx.agentId === "string" && toolCtx.agentId.length > 0) {
    const byAgentId = deps.sessionByAgentId.get(toolCtx.agentId);
    if (byAgentId && deps.activeTraces.has(byAgentId)) {
      return { sessionKey: byAgentId, fallbackMode: "agentId" };
    }
  }
  if (deps.activeTraces.size === 1) {
    return {
      sessionKey: deps.activeTraces.keys().next().value as string | undefined,
      fallbackMode: "single active trace",
    };
  }
  if (allowLastActive) {
    const lastActiveSessionKey = deps.getLastActiveSessionKey();
    if (lastActiveSessionKey && deps.activeTraces.has(lastActiveSessionKey)) {
      return { sessionKey: lastActiveSessionKey, fallbackMode: "last active session" };
    }
  }
  return {};
}

/** Creates a tool span under the session's active LLM span, or under the session container. */
function createToolSpan(
  deps: ToolHooksDeps,
  container: SessionSpanContainer,
  sessionKey: string,
  span: { toolName: string; params: unknown; metadata: Record<string, unknown>; startTime?: Date },
): Span | undefined {
  const parent =
    container.sessionKey === sessionKey && container.active.llmSpan
      ? container.active.llmSpan
      : container.parent;
  try {
    return parent.span({
      name: span.toolName,
      type: "tool",
      input: sanitizeValueForOpik(span.params) as any,
      ...(span.startTime ? { startTime: span.startTime } : {}),
      ...(Object.keys(span.metadata).length > 0 ? { metadata: span.metadata } : {}),
    });
  } catch (err) {
    deps.warn(
      `opik: tool span creation failed (sessionKey=${sessionKey}, tool=${span.toolName}): ${deps.formatError(err)}`,
    );
    return undefined;
  }
}

export function registerToolHooks(deps: ToolHooksDeps): void {
  // toolCallIds whose before_tool_call couldn't be tied to a session; after_tool_call backfills
  // spans for these and only these, so an unmatched call never produces a duplicate span.
  const skippedToolCallIds = new Map<string, number>();
  const pruneSkippedToolCalls = (now: number) => {
    for (const [id, skippedAt] of skippedToolCallIds) {
      if (now - skippedAt <= SKIPPED_TOOL_CALL_TTL_MS && skippedToolCallIds.size < MAX_SKIPPED_TOOL_CALLS) {
        break;
      }
      skippedToolCallIds.delete(id);
    }
  };

  deps.api.on("before_tool_call", (event, toolCtx) => {
    if (!deps.getClient()) return;
    const eventObj = event as Record<string, unknown>;
    const ctxObj = toolCtx as Record<string, unknown>;
    const toolCallId = resolveToolCallId(eventObj, ctxObj);
    // Only an unambiguous guess here: a wrong session would put the span in another trace, and
    // after_tool_call (which gets the full context) creates the span when we can't tell.
    const { sessionKey } = resolveToolSessionKey(deps, toolCtx, { allowLastActive: false });
    if (!sessionKey) {
      if (toolCallId) {
        const now = Date.now();
        pruneSkippedToolCalls(now);
        skippedToolCallIds.delete(toolCallId);
        skippedToolCallIds.set(toolCallId, now);
      }
      return;
    }
    deps.rememberSessionCorrelation(sessionKey, toolCtx.agentId);

    const container = deps.resolveSessionSpanContainer(sessionKey);
    if (!container) return;
    const active = container.active;

    active.lastActivityAt = Date.now();

    const runId = resolveRunId(eventObj, ctxObj);
    const sessionId = asNonEmptyString(ctxObj.sessionId);

    const spanMetadata: Record<string, unknown> = {
      ...(toolCtx.agentId ? { agentId: toolCtx.agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    };

    const toolSpan = createToolSpan(deps, container, sessionKey, {
      toolName: event.toolName,
      params: event.params,
      metadata: spanMetadata,
    });
    if (!toolSpan) return;

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
      projectName: deps.getProjectName(),
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

    const { sessionKey, fallbackMode } = resolveToolSessionKey(deps, toolCtx, {
      allowLastActive: true,
    });
    if (sessionKey && fallbackMode) {
      deps.warnMissingAfterToolSessionKey(fallbackMode);
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
    // Backfill only a call before_tool_call skipped recently, and only into a session this hook can
    // identify for sure: guessing from recent activity could put the span into another trace.
    const skippedAt = toolCallId ? skippedToolCallIds.get(toolCallId) : undefined;
    if (toolCallId) skippedToolCallIds.delete(toolCallId);
    const isBackfill =
      !matchedSpan &&
      skippedAt !== undefined &&
      Date.now() - skippedAt <= SKIPPED_TOOL_CALL_TTL_MS &&
      fallbackMode !== "last active session";
    if (isBackfill) {
      // before_tool_call had no usable session context (bundle-MCP tools) and we couldn't guess
      // it safely. Create the span now, in the session this call reports, back-dated by its duration.
      const durationMs =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
          ? event.durationMs
          : 0;
      matchedSpan = createToolSpan(deps, container, sessionKey, {
        toolName: event.toolName,
        params: event.params,
        metadata: { backfilled: true, toolCallId },
        startTime: new Date(Date.now() - durationMs),
      });
    }
    if (!matchedSpan) return;

    const spanUpdate: Record<string, unknown> = {};
    if (event.params && typeof event.params === "object" && !Array.isArray(event.params)) {
      spanUpdate.input = sanitizeValueForOpik(event.params) as Record<string, unknown>;
    }
    const spanMetadata: Record<string, unknown> = {
      ...(isBackfill ? { backfilled: true } : {}),
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
      projectName: deps.getProjectName(),
      reason: `after_tool_call sessionKey=${sessionKey} tool=${event.toolName}`,
      payloads: [event.params, event.result, event.error],
    });

    deps.safeSpanEnd(
      matchedSpan,
      `after_tool_call sessionKey=${sessionKey} tool=${event.toolName} key=${matchedKey}`,
    );
    if (matchedKey) active.toolSpans.delete(matchedKey);
  });
}
