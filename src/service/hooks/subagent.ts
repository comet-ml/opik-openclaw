import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Opik, Span } from "opik";
import type { ActiveTrace } from "../../types.js";
import { asNonEmptyString } from "../helpers.js";
import { sanitizeStringForOpik } from "../payload-sanitizer.js";

function asStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

type SubagentHooksDeps = {
  api: OpenClawPluginApi;
  getClient: () => Opik | null;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  resolveSubagentHostTrace: (params: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    targetSessionKey?: string;
  }) => { sessionKey: string; active: ActiveTrace } | undefined;
  safeSpanUpdate: (span: Span, payload: Record<string, unknown>, reason: string) => void;
  safeSpanEnd: (span: Span, reason: string) => void;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export function registerSubagentHooks(deps: SubagentHooksDeps): void {
  deps.api.on("subagent_spawning", (event, subagentCtx) => {
    if (!deps.getClient()) return;

    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;

    const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey =
      asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
    if (!childSessionKey) return;

    const host = deps.resolveSubagentHostTrace({ requesterSessionKey, childSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    const existing = host.active.subagentSpans.get(childSessionKey);
    if (existing) {
      deps.safeSpanEnd(existing, `subagent reset childSessionKey=${childSessionKey}`);
      host.active.subagentSpans.delete(childSessionKey);
    }

    try {
      const span = host.active.trace.span({
        name: `subagent:${asNonEmptyString(eventObj.agentId) ?? "unknown"}`,
        input: {
          childSessionKey,
          agentId: eventObj.agentId,
          label: eventObj.label,
          mode: eventObj.mode,
          requester: eventObj.requester,
          threadRequested: eventObj.threadRequested,
        },
        metadata: {
          status: "spawning",
          requesterSessionKey,
          childSessionKey,
          runId: asNonEmptyString(ctxObj.runId),
        },
      });
      host.active.subagentSpans.set(childSessionKey, span);
    } catch (err) {
      deps.warn(
        `opik: subagent span creation failed (childSessionKey=${childSessionKey}): ${deps.formatError(err)}`,
      );
    }
  });

  deps.api.on("subagent_spawned", (event, subagentCtx) => {
    if (!deps.getClient()) return;

    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;

    const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey =
      asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
    if (!childSessionKey) return;

    const host = deps.resolveSubagentHostTrace({ requesterSessionKey, childSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    let span = host.active.subagentSpans.get(childSessionKey);
    if (!span) {
      try {
        span = host.active.trace.span({
          name: `subagent:${asNonEmptyString(eventObj.agentId) ?? "unknown"}`,
          input: {
            childSessionKey,
            agentId: eventObj.agentId,
            mode: eventObj.mode,
          },
        });
        host.active.subagentSpans.set(childSessionKey, span);
      } catch (err) {
        deps.warn(
          `opik: subagent span creation failed on spawn (childSessionKey=${childSessionKey}): ${deps.formatError(err)}`,
        );
        return;
      }
    }

    deps.safeSpanUpdate(
      span,
      {
        metadata: {
          status: "spawned",
          requesterSessionKey,
          childSessionKey,
          runId: asNonEmptyString(eventObj.runId) ?? asNonEmptyString(ctxObj.runId),
          agentId: eventObj.agentId,
          mode: eventObj.mode,
          threadRequested: eventObj.threadRequested,
        },
      },
      `subagent_spawned childSessionKey=${childSessionKey}`,
    );
  });

  deps.api.on("subagent_delivery_target", (event, subagentCtx) => {
    if (!deps.getClient()) return;

    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;

    const requesterSessionKey =
      asNonEmptyString(eventObj.requesterSessionKey) ?? asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey =
      asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
    if (!childSessionKey) return;

    const host = deps.resolveSubagentHostTrace({ requesterSessionKey, childSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    let span = host.active.subagentSpans.get(childSessionKey);
    if (!span) {
      try {
        span = host.active.trace.span({
          name: "subagent:delivery-target",
          input: {
            childSessionKey,
            requesterSessionKey,
          },
        });
        host.active.subagentSpans.set(childSessionKey, span);
      } catch (err) {
        deps.warn(
          `opik: subagent span creation failed on delivery target (childSessionKey=${childSessionKey}): ${deps.formatError(err)}`,
        );
        return;
      }
    }

    const requesterOrigin =
      eventObj.requesterOrigin && typeof eventObj.requesterOrigin === "object" && !Array.isArray(eventObj.requesterOrigin)
        ? (eventObj.requesterOrigin as Record<string, unknown>)
        : undefined;
    const childRunId = asNonEmptyString(eventObj.childRunId);
    const spawnMode = asNonEmptyString(eventObj.spawnMode);
    const expectsCompletionMessage = typeof eventObj.expectsCompletionMessage === "boolean"
      ? eventObj.expectsCompletionMessage
      : undefined;
    const originChannel = asNonEmptyString(requesterOrigin?.channel);
    const originAccountId = asNonEmptyString(requesterOrigin?.accountId);
    const originTo = asNonEmptyString(requesterOrigin?.to);
    const originThreadId = asStringOrNumber(requesterOrigin?.threadId);

    deps.safeSpanUpdate(
      span,
      {
        metadata: {
          status: "delivery_target",
          requesterSessionKey,
          childSessionKey,
          ...(childRunId ? { childRunId } : {}),
          ...(spawnMode ? { spawnMode } : {}),
          ...(expectsCompletionMessage !== undefined ? { expectsCompletionMessage } : {}),
          ...(originChannel ? { originChannel } : {}),
          ...(originAccountId ? { originAccountId } : {}),
          ...(originTo ? { originTo } : {}),
          ...(originThreadId !== undefined ? { originThreadId } : {}),
        },
      },
      `subagent_delivery_target childSessionKey=${childSessionKey}`,
    );
  });

  deps.api.on("subagent_ended", (event, subagentCtx) => {
    if (!deps.getClient()) return;

    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;

    const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey = asNonEmptyString(ctxObj.childSessionKey);
    const targetSessionKey =
      asNonEmptyString(eventObj.targetSessionKey) ?? childSessionKey;

    const host = deps.resolveSubagentHostTrace({ requesterSessionKey, childSessionKey, targetSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    let span = targetSessionKey ? host.active.subagentSpans.get(targetSessionKey) : undefined;
    if (!span) {
      try {
        span = host.active.trace.span({
          name: `subagent:${asNonEmptyString(eventObj.targetKind) ?? "unknown"}`,
          input: {
            targetSessionKey,
            targetKind: eventObj.targetKind,
            reason: eventObj.reason,
          },
        });
      } catch (err) {
        deps.warn(
          `opik: subagent span creation failed on end (targetSessionKey=${targetSessionKey ?? "unknown"}): ${deps.formatError(err)}`,
        );
        return;
      }
    }

    const spanUpdate: Record<string, unknown> = {
      metadata: {
        status: "ended",
        targetSessionKey,
        requesterSessionKey,
        targetKind: eventObj.targetKind,
        reason: eventObj.reason,
        outcome: eventObj.outcome,
        sendFarewell: eventObj.sendFarewell,
        endedAt: eventObj.endedAt,
        accountId: eventObj.accountId,
        runId: asNonEmptyString(eventObj.runId) ?? asNonEmptyString(ctxObj.runId),
      },
    };

    const error = asNonEmptyString(eventObj.error);
    if (error) {
      const sanitizedError = sanitizeStringForOpik(error);
      spanUpdate.output = { error: sanitizedError };
      spanUpdate.errorInfo = {
        exceptionType: "SubagentError",
        message: sanitizedError,
        traceback: sanitizedError,
      };
    }

    deps.safeSpanUpdate(
      span,
      spanUpdate,
      `subagent_ended targetSessionKey=${targetSessionKey ?? "unknown"}`,
    );

    deps.safeSpanEnd(span, `subagent_ended targetSessionKey=${targetSessionKey ?? "unknown"}`);
    if (targetSessionKey) {
      host.active.subagentSpans.delete(targetSessionKey);
    }
  });
}
