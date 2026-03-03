import type {
  DiagnosticEventPayload,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import { Opik, type Span, type Trace } from "opik";
import { parseOpikPluginConfig, type ActiveTrace, type OpikPluginConfig } from "./types.js";

/** Map OpenClaw usage fields to Opik's expected token field names. */
function mapUsageToOpikTokens(
  usage: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  const mapped: Record<string, number> = {};
  if (usage.input != null) mapped.prompt_tokens = usage.input as number;
  if (usage.output != null) mapped.completion_tokens = usage.output as number;
  if (usage.total != null) mapped.total_tokens = usage.total as number;
  if (usage.cacheRead != null) mapped.cache_read_tokens = usage.cacheRead as number;
  if (usage.cacheWrite != null) mapped.cache_write_tokens = usage.cacheWrite as number;
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

const DEFAULT_STALE_TRACE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STALE_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_FLUSH_RETRY_COUNT = 2;
const DEFAULT_FLUSH_RETRY_BASE_DELAY_MS = 250;
const MAX_FLUSH_RETRY_DELAY_MS = 5000;

type ServiceLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function hasUsageFields(usage: ActiveTrace["usage"]): boolean {
  return (
    usage.input != null ||
    usage.output != null ||
    usage.cacheRead != null ||
    usage.cacheWrite != null ||
    usage.total != null
  );
}

function hasCostUsageFields(costMeta: ActiveTrace["costMeta"]): boolean {
  return (
    costMeta.usageInput != null ||
    costMeta.usageOutput != null ||
    costMeta.usageCacheRead != null ||
    costMeta.usageCacheWrite != null ||
    costMeta.usageTotal != null
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readLegacyOpikConfig(config: unknown): OpikPluginConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  const root = config as Record<string, unknown>;
  return parseOpikPluginConfig(root.opik);
}

export function createOpikService(
  api: OpenClawPluginApi,
  pluginConfig: OpikPluginConfig = {},
): OpenClawPluginService {
  let client: Opik | null = null;
  const activeTraces = new Map<string, ActiveTrace>();
  const sessionByAgentId = new Map<string, string>();
  let cleanup: (() => void) | null = null;
  let spanSeq = 0;
  let lastActiveSessionKey: string | undefined;
  let warnedMissingAfterToolSessionKey = false;
  let log: ServiceLogger = {
    info: () => undefined,
    warn: () => undefined,
  };

  let staleTraceTimeoutMs = DEFAULT_STALE_TRACE_TIMEOUT_MS;
  let staleSweepIntervalMs = DEFAULT_STALE_SWEEP_INTERVAL_MS;
  let staleTraceCleanupEnabled = true;
  let flushRetryCount = DEFAULT_FLUSH_RETRY_COUNT;
  let flushRetryBaseDelayMs = DEFAULT_FLUSH_RETRY_BASE_DELAY_MS;

  let flushQueue: Promise<void> = Promise.resolve();

  const exporterMetrics = {
    traceUpdateErrors: 0,
    traceEndErrors: 0,
    spanUpdateErrors: 0,
    spanEndErrors: 0,
    flushSuccesses: 0,
    flushFailures: 0,
    flushRetries: 0,
  };

  function rememberSessionCorrelation(sessionKey: string, agentId?: unknown): void {
    lastActiveSessionKey = sessionKey;
    if (typeof agentId === "string" && agentId.length > 0) {
      sessionByAgentId.set(agentId, sessionKey);
    }
  }

  function forgetSessionCorrelation(sessionKey: string): void {
    if (lastActiveSessionKey === sessionKey) {
      lastActiveSessionKey = undefined;
    }
    for (const [agentId, mappedSessionKey] of sessionByAgentId) {
      if (mappedSessionKey === sessionKey) {
        sessionByAgentId.delete(agentId);
      }
    }
  }

  function warnMissingAfterToolSessionKey(fallbackMode: string): void {
    if (warnedMissingAfterToolSessionKey) return;
    warnedMissingAfterToolSessionKey = true;
    log.warn(
      `opik: after_tool_call missing sessionKey; using ${fallbackMode} fallback correlation (upgrade OpenClaw for strict context propagation)`,
    );
  }

  function safeTraceUpdate(traceRef: Trace, payload: Record<string, unknown>, reason: string): void {
    try {
      traceRef.update(payload);
    } catch (err) {
      exporterMetrics.traceUpdateErrors += 1;
      log.warn(`opik: trace.update failed (${reason}): ${formatError(err)}`);
    }
  }

  function safeTraceEnd(traceRef: Trace, reason: string): void {
    try {
      traceRef.end();
    } catch (err) {
      exporterMetrics.traceEndErrors += 1;
      log.warn(`opik: trace.end failed (${reason}): ${formatError(err)}`);
    }
  }

  function safeSpanUpdate(span: Span, payload: Record<string, unknown>, reason: string): void {
    try {
      span.update(payload);
    } catch (err) {
      exporterMetrics.spanUpdateErrors += 1;
      log.warn(`opik: span.update failed (${reason}): ${formatError(err)}`);
    }
  }

  function safeSpanEnd(span: Span, reason: string): void {
    try {
      span.end();
    } catch (err) {
      exporterMetrics.spanEndErrors += 1;
      log.warn(`opik: span.end failed (${reason}): ${formatError(err)}`);
    }
  }

  function endChildSpans(active: ActiveTrace, reason: string): void {
    for (const [toolKey, toolSpan] of active.toolSpans) {
      safeSpanEnd(toolSpan, `${reason} toolKey=${toolKey}`);
    }
    active.toolSpans.clear();

    for (const [subagentKey, subagentSpan] of active.subagentSpans) {
      safeSpanEnd(subagentSpan, `${reason} subagentKey=${subagentKey}`);
    }
    active.subagentSpans.clear();

    if (active.llmSpan) {
      safeSpanEnd(active.llmSpan, `${reason} llm`);
      active.llmSpan = null;
    }
  }

  function closeActiveTrace(active: ActiveTrace, reason: string): void {
    endChildSpans(active, reason);

    // Clear deferred finalization state so stale microtasks no-op.
    active.agentEnd = undefined;
    active.output = undefined;

    safeTraceEnd(active.trace, reason);
  }

  function resolveSubagentHostTrace(params: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    targetSessionKey?: string;
  }): { sessionKey: string; active: ActiveTrace } | undefined {
    const candidates = [params.requesterSessionKey, params.childSessionKey, params.targetSessionKey];
    for (const key of candidates) {
      if (!key) continue;
      const active = activeTraces.get(key);
      if (active) {
        return { sessionKey: key, active };
      }
    }
    return undefined;
  }

  async function flushWithRetry(reason: string): Promise<void> {
    const currentClient = client;
    if (!currentClient) return;

    const attempts = flushRetryCount + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await currentClient.flush();
        exporterMetrics.flushSuccesses += 1;
        return;
      } catch (err) {
        exporterMetrics.flushFailures += 1;
        log.warn(
          `opik: flush failed (${reason}) attempt ${attempt}/${attempts}: ${formatError(err)}`,
        );

        if (attempt >= attempts) {
          return;
        }

        exporterMetrics.flushRetries += 1;
        const delayMs = Math.min(
          flushRetryBaseDelayMs * 2 ** (attempt - 1),
          MAX_FLUSH_RETRY_DELAY_MS,
        );
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }
  }

  function scheduleFlush(reason: string): void {
    flushQueue = flushQueue.then(() => flushWithRetry(reason)).catch(() => undefined);
  }

  /** Consolidate output + metadata into a single trace.update() + trace.end(). */
  function finalizeTrace(sessionKey: string): void {
    const active = activeTraces.get(sessionKey);
    if (!active) return;

    // End any remaining open child spans (LLM span if llm_output didn't fire).
    endChildSpans(active, `finalize sessionKey=${sessionKey}`);

    // Build output: prefer llm_output data, fall back to last assistant from messages.
    let output: Record<string, unknown> | undefined;
    if (active.output) {
      output = active.output;
    } else if (active.agentEnd?.messages?.length) {
      const last = [...active.agentEnd.messages]
        .reverse()
        .find((m) => (m as Record<string, unknown>)?.role === "assistant");
      if (last) output = { output: "", lastAssistant: last };
    }

    const agentEnd = active.agentEnd;
    const metadata: Record<string, unknown> = {
      ...active.costMeta,
      success: agentEnd?.success,
      durationMs: agentEnd?.durationMs,
      model: active.model ?? active.costMeta.model,
      provider: active.provider ?? active.costMeta.provider,
    };

    // Prefer accumulated llm_output usage, fall back to diagnostic costMeta usage.
    if (hasUsageFields(active.usage)) {
      metadata.usage = { ...active.usage };
    } else if (hasCostUsageFields(active.costMeta)) {
      metadata.usage = {
        input: active.costMeta.usageInput,
        output: active.costMeta.usageOutput,
        cacheRead: active.costMeta.usageCacheRead,
        cacheWrite: active.costMeta.usageCacheWrite,
        total: active.costMeta.usageTotal,
      };
    }

    if (agentEnd?.error) metadata.error = agentEnd.error;

    safeTraceUpdate(
      active.trace,
      {
        ...(output ? { output } : {}),
        metadata,
        ...(agentEnd?.error
          ? {
              errorInfo: {
                exceptionType: "AgentError",
                message: agentEnd.error,
                traceback: agentEnd.error,
              },
            }
          : {}),
      },
      `finalize sessionKey=${sessionKey}`,
    );

    safeTraceEnd(active.trace, `finalize sessionKey=${sessionKey}`);
    activeTraces.delete(sessionKey);
    forgetSessionCorrelation(sessionKey);
    scheduleFlush(`trace-finalized sessionKey=${sessionKey}`);
  }

  return {
    id: "opik",
    async start(ctx) {
      log = {
        info: ctx.logger.info.bind(ctx.logger),
        warn: ctx.logger.warn.bind(ctx.logger),
      };

      const legacyCfg = readLegacyOpikConfig(ctx.config);
      const opikCfg: OpikPluginConfig = { ...legacyCfg, ...pluginConfig };

      if (!opikCfg?.enabled) {
        return;
      }

      const apiKey = opikCfg.apiKey ?? process.env.OPIK_API_KEY;
      const apiUrl = opikCfg.apiUrl ?? process.env.OPIK_URL_OVERRIDE;
      const projectName = opikCfg.projectName ?? process.env.OPIK_PROJECT_NAME ?? "openclaw";
      const workspaceName = opikCfg.workspaceName ?? process.env.OPIK_WORKSPACE ?? "default";
      const tags = opikCfg.tags ?? ["openclaw"];

      staleTraceCleanupEnabled = opikCfg.staleTraceCleanupEnabled !== false;
      staleTraceTimeoutMs = Math.max(
        1000,
        asNonNegativeNumber(opikCfg.staleTraceTimeoutMs) ?? DEFAULT_STALE_TRACE_TIMEOUT_MS,
      );
      staleSweepIntervalMs = Math.max(
        1000,
        asNonNegativeNumber(opikCfg.staleSweepIntervalMs) ?? DEFAULT_STALE_SWEEP_INTERVAL_MS,
      );
      flushRetryCount = Math.floor(
        asNonNegativeNumber(opikCfg.flushRetryCount) ?? DEFAULT_FLUSH_RETRY_COUNT,
      );
      flushRetryBaseDelayMs = asNonNegativeNumber(opikCfg.flushRetryBaseDelayMs) ??
        DEFAULT_FLUSH_RETRY_BASE_DELAY_MS;

      client = new Opik({
        apiKey,
        ...(apiUrl ? { apiUrl } : {}),
        projectName,
        workspaceName,
      });

      // =====================================================================
      // Hook: llm_input — Create Opik Trace + LLM Span
      // =====================================================================
      api.on("llm_input", (event, agentCtx) => {
        if (!client) return;
        const sessionKey = agentCtx.sessionKey;
        if (!sessionKey) return;
        rememberSessionCorrelation(sessionKey, agentCtx.agentId);

        // Close any pre-existing trace for this session to avoid leaks.
        const existing = activeTraces.get(sessionKey);
        if (existing) {
          closeActiveTrace(existing, `replace active trace sessionKey=${sessionKey}`);
          activeTraces.delete(sessionKey);
          forgetSessionCorrelation(sessionKey);
        }

        let trace: Trace;
        try {
          trace = client.trace({
            name: `${event.model} · ${agentCtx.messageProvider ?? "unknown"}`,
            threadId: sessionKey,
            input: {
              prompt: event.prompt,
              systemPrompt: event.systemPrompt,
              imagesCount: event.imagesCount,
            },
            metadata: {
              provider: event.provider,
              model: event.model,
              sessionId: event.sessionId,
              runId: event.runId,
              agentId: agentCtx.agentId,
              channel: agentCtx.messageProvider,
            },
            tags: tags.length > 0 ? tags : undefined,
          });
        } catch (err) {
          log.warn(`opik: trace creation failed (sessionKey=${sessionKey}): ${formatError(err)}`);
          return;
        }

        let llmSpan: Span | null = null;
        try {
          llmSpan = trace.span({
            name: event.model,
            type: "llm",
            model: event.model,
            provider: event.provider,
            input: {
              prompt: event.prompt,
              systemPrompt: event.systemPrompt,
              historyMessages: event.historyMessages,
              imagesCount: event.imagesCount,
            },
          });
        } catch (err) {
          log.warn(`opik: llm span creation failed (sessionKey=${sessionKey}): ${formatError(err)}`);
        }

        const now = Date.now();
        activeTraces.set(sessionKey, {
          trace,
          llmSpan,
          toolSpans: new Map(),
          subagentSpans: new Map(),
          startedAt: now,
          lastActivityAt: now,
          costMeta: {},
          usage: {},
          model: event.model,
          provider: event.provider,
        });
      });

      // =====================================================================
      // Hook: llm_output — Update LLM Span with response + usage, then end
      // =====================================================================
      api.on("llm_output", (event, agentCtx) => {
        if (!client) return;
        const sessionKey = agentCtx.sessionKey;
        if (!sessionKey) return;
        rememberSessionCorrelation(sessionKey, agentCtx.agentId);

        const active = activeTraces.get(sessionKey);
        if (!active?.llmSpan) return;

        active.lastActivityAt = Date.now();

        // Trace output uses joined text for readability; LLM span retains raw array for debugging.
        safeSpanUpdate(
          active.llmSpan,
          {
            output: {
              assistantTexts: event.assistantTexts,
              lastAssistant: event.lastAssistant,
            },
            usage: mapUsageToOpikTokens(event.usage),
            model: event.model,
            provider: event.provider,
          },
          `llm_output sessionKey=${sessionKey}`,
        );

        // Store output for deferred trace-level finalization.
        active.output = {
          output: event.assistantTexts.join("\n\n"),
          lastAssistant: event.lastAssistant,
        };

        // Accumulate usage + model on the ActiveTrace for finalization metadata.
        if (event.usage) {
          active.usage = { ...active.usage, ...event.usage };
        }
        active.model = event.model;
        active.provider = event.provider;

        safeSpanEnd(active.llmSpan, `llm_output sessionKey=${sessionKey}`);
        active.llmSpan = null;
      });

      // =====================================================================
      // Hook: before_tool_call — Create Tool Span
      // =====================================================================
      api.on("before_tool_call", (event, toolCtx) => {
        if (!client) return;
        const sessionKey = toolCtx.sessionKey;
        if (!sessionKey) return;
        rememberSessionCorrelation(sessionKey, toolCtx.agentId);

        const active = activeTraces.get(sessionKey);
        if (!active) return;

        active.lastActivityAt = Date.now();

        let toolSpan: Span;
        try {
          toolSpan = active.trace.span({
            name: event.toolName,
            type: "tool",
            input: event.params,
          });
        } catch (err) {
          log.warn(
            `opik: tool span creation failed (sessionKey=${sessionKey}, tool=${event.toolName}): ${formatError(err)}`,
          );
          return;
        }

        // Use a monotonic counter to avoid collisions within the same tick.
        const spanKey = `${event.toolName}:${++spanSeq}`;
        active.toolSpans.set(spanKey, toolSpan);
      });

      // =====================================================================
      // Hook: after_tool_call — Finalize Tool Span
      // =====================================================================
      api.on("after_tool_call", (event, toolCtx) => {
        if (!client) return;
        let sessionKey = toolCtx.sessionKey;
        let fallbackMode: "agentId" | "single active trace" | "last active session" | undefined;
        if (!sessionKey) {
          if (typeof toolCtx.agentId === "string" && toolCtx.agentId.length > 0) {
            const byAgentId = sessionByAgentId.get(toolCtx.agentId);
            if (byAgentId && activeTraces.has(byAgentId)) {
              sessionKey = byAgentId;
              fallbackMode = "agentId";
            }
          }
          if (!sessionKey && activeTraces.size === 1) {
            sessionKey = activeTraces.keys().next().value as string | undefined;
            fallbackMode = "single active trace";
          } else if (!sessionKey && lastActiveSessionKey && activeTraces.has(lastActiveSessionKey)) {
            sessionKey = lastActiveSessionKey;
            fallbackMode = "last active session";
          }
          if (sessionKey && fallbackMode) {
            warnMissingAfterToolSessionKey(fallbackMode);
          }
        }
        if (!sessionKey) return;
        rememberSessionCorrelation(sessionKey, toolCtx.agentId);

        const active = activeTraces.get(sessionKey);
        if (!active) return;

        active.lastActivityAt = Date.now();

        // Find the matching tool span (FIFO: oldest span for this tool name).
        let matchedKey: string | undefined;
        let matchedSpan: Span | undefined;
        for (const [key, span] of active.toolSpans) {
          if (key.startsWith(`${event.toolName}:`)) {
            matchedKey = key;
            matchedSpan = span;
            break;
          }
        }
        if (!matchedKey || !matchedSpan) return;

        const spanUpdate: Record<string, unknown> = {};
        if (event.params && typeof event.params === "object" && !Array.isArray(event.params)) {
          spanUpdate.input = event.params;
        }
        if (event.durationMs !== undefined || toolCtx.agentId) {
          spanUpdate.metadata = {
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(toolCtx.agentId ? { agentId: toolCtx.agentId } : {}),
          };
        }

        if (event.error) {
          spanUpdate.output = { error: event.error };
          spanUpdate.errorInfo = {
            exceptionType: "ToolError",
            message: event.error,
            traceback: event.error,
          };
        } else if (event.result !== undefined) {
          const output =
            typeof event.result === "object" && event.result !== null
              ? (event.result as Record<string, unknown>)
              : { result: event.result };
          spanUpdate.output = output;
        }

        if (Object.keys(spanUpdate).length > 0) {
          safeSpanUpdate(
            matchedSpan,
            spanUpdate,
            `after_tool_call sessionKey=${sessionKey} tool=${event.toolName}`,
          );
        }

        safeSpanEnd(
          matchedSpan,
          `after_tool_call sessionKey=${sessionKey} tool=${event.toolName} key=${matchedKey}`,
        );
        active.toolSpans.delete(matchedKey);
      });

      // =====================================================================
      // Hook: subagent_spawning — Start subagent span on requester trace
      // =====================================================================
      api.on("subagent_spawning", (event, subagentCtx) => {
        if (!client) return;

        const eventObj = event as Record<string, unknown>;
        const ctxObj = subagentCtx as Record<string, unknown>;

        const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
        const childSessionKey =
          asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
        if (!childSessionKey) return;

        const host = resolveSubagentHostTrace({ requesterSessionKey, childSessionKey });
        if (!host) return;

        rememberSessionCorrelation(host.sessionKey);
        host.active.lastActivityAt = Date.now();

        const existing = host.active.subagentSpans.get(childSessionKey);
        if (existing) {
          safeSpanEnd(existing, `subagent reset childSessionKey=${childSessionKey}`);
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
          log.warn(
            `opik: subagent span creation failed (childSessionKey=${childSessionKey}): ${formatError(err)}`,
          );
        }
      });

      // =====================================================================
      // Hook: subagent_spawned — Update subagent span with run details
      // =====================================================================
      api.on("subagent_spawned", (event, subagentCtx) => {
        if (!client) return;

        const eventObj = event as Record<string, unknown>;
        const ctxObj = subagentCtx as Record<string, unknown>;

        const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
        const childSessionKey =
          asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
        if (!childSessionKey) return;

        const host = resolveSubagentHostTrace({ requesterSessionKey, childSessionKey });
        if (!host) return;

        rememberSessionCorrelation(host.sessionKey);
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
            log.warn(
              `opik: subagent span creation failed on spawn (childSessionKey=${childSessionKey}): ${formatError(err)}`,
            );
            return;
          }
        }

        safeSpanUpdate(
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

      // =====================================================================
      // Hook: subagent_ended — Finalize subagent span
      // =====================================================================
      api.on("subagent_ended", (event, subagentCtx) => {
        if (!client) return;

        const eventObj = event as Record<string, unknown>;
        const ctxObj = subagentCtx as Record<string, unknown>;

        const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
        const childSessionKey = asNonEmptyString(ctxObj.childSessionKey);
        const targetSessionKey =
          asNonEmptyString(eventObj.targetSessionKey) ?? childSessionKey;

        const host = resolveSubagentHostTrace({ requesterSessionKey, childSessionKey, targetSessionKey });
        if (!host) return;

        rememberSessionCorrelation(host.sessionKey);
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
            log.warn(
              `opik: subagent span creation failed on end (targetSessionKey=${targetSessionKey ?? "unknown"}): ${formatError(err)}`,
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
          spanUpdate.output = { error };
          spanUpdate.errorInfo = {
            exceptionType: "SubagentError",
            message: error,
            traceback: error,
          };
        }

        safeSpanUpdate(
          span,
          spanUpdate,
          `subagent_ended targetSessionKey=${targetSessionKey ?? "unknown"}`,
        );

        safeSpanEnd(span, `subagent_ended targetSessionKey=${targetSessionKey ?? "unknown"}`);
        if (targetSessionKey) {
          host.active.subagentSpans.delete(targetSessionKey);
        }
      });

      // =====================================================================
      // Hook: agent_end — Finalize Trace
      // =====================================================================
      api.on("agent_end", (event, agentCtx) => {
        const sessionKey = agentCtx.sessionKey;
        if (!sessionKey) return;
        rememberSessionCorrelation(sessionKey, agentCtx.agentId);

        const active = activeTraces.get(sessionKey);
        if (!active) return;

        // Close any orphaned tool/subagent spans synchronously.
        for (const [toolKey, toolSpan] of active.toolSpans) {
          safeSpanEnd(toolSpan, `agent_end orphan tool sessionKey=${sessionKey} toolKey=${toolKey}`);
        }
        active.toolSpans.clear();

        for (const [subagentKey, subagentSpan] of active.subagentSpans) {
          safeSpanEnd(
            subagentSpan,
            `agent_end orphan subagent sessionKey=${sessionKey} subagentKey=${subagentKey}`,
          );
        }
        active.subagentSpans.clear();

        // Store agent-end data for deferred finalization.
        active.agentEnd = {
          success: event.success,
          error: event.error,
          durationMs: event.durationMs,
          messages: ((event as Record<string, unknown>).messages as unknown[]) ?? [],
        };

        // Defer finalization to a microtask so llm_output (which fires on the
        // same synchronous call stack) can store output/usage first.
        const traceRef = active.trace;
        queueMicrotask(() => {
          const current = activeTraces.get(sessionKey);
          if (current && current.trace === traceRef) finalizeTrace(sessionKey);
        });
      });

      // =====================================================================
      // Diagnostic event: model.usage — Accumulate cost/context info
      // =====================================================================
      const unsubscribeDiagnostics = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        if (evt.type !== "model.usage") return;

        const sessionKey = evt.sessionKey;
        if (!sessionKey) return;

        const active = activeTraces.get(sessionKey);
        if (!active) return;

        // Accumulate cost metadata — will be merged into trace at agent_end.
        if (evt.costUsd !== undefined) {
          active.costMeta.costUsd = evt.costUsd;
        }
        if (evt.context?.limit !== undefined) {
          active.costMeta.contextLimit = evt.context.limit;
        }
        if (evt.context?.used !== undefined) {
          active.costMeta.contextUsed = evt.context.used;
        }
        if (evt.model) active.costMeta.model = evt.model;
        if (evt.provider) active.costMeta.provider = evt.provider;
        if (evt.durationMs !== undefined) active.costMeta.durationMs = evt.durationMs;
        if (evt.usage) {
          active.costMeta.usageInput = evt.usage.input;
          active.costMeta.usageOutput = evt.usage.output;
          active.costMeta.usageCacheRead = evt.usage.cacheRead;
          active.costMeta.usageCacheWrite = evt.usage.cacheWrite;
          active.costMeta.usageTotal = evt.usage.total;
        }
      });

      // =====================================================================
      // Stale trace cleanup interval (based on inactivity, not age)
      // =====================================================================
      const sweepInterval = staleTraceCleanupEnabled
        ? setInterval(() => {
            const now = Date.now();
            for (const [key, active] of activeTraces) {
              if (now - active.lastActivityAt > staleTraceTimeoutMs) {
                endChildSpans(active, `stale cleanup sessionKey=${key}`);

                // Mark trace as stale before closing.
                safeTraceUpdate(
                  active.trace,
                  {
                    metadata: { staleCleanup: true },
                    errorInfo: {
                      exceptionType: "StaleTrace",
                      message: "Trace exceeded maximum inactivity threshold and was forcibly ended",
                      traceback: `Stale trace for sessionKey=${key}, inactive=${now - active.lastActivityAt}ms`,
                    },
                  },
                  `stale cleanup sessionKey=${key}`,
                );

                safeTraceEnd(active.trace, `stale cleanup sessionKey=${key}`);
                activeTraces.delete(key);
                forgetSessionCorrelation(key);
              }
            }

            // Flush when no active traces remain.
            if (activeTraces.size === 0) {
              scheduleFlush("stale cleanup empty active traces");
            }
          }, staleSweepIntervalMs)
        : null;

      // =====================================================================
      // Wire cleanup
      // =====================================================================
      cleanup = () => {
        unsubscribeDiagnostics();
        if (sweepInterval) {
          clearInterval(sweepInterval);
        }
      };

      log.info(
        `opik: exporting traces to project "${projectName}" (staleCleanup=${staleTraceCleanupEnabled ? "on" : "off"}, staleTimeoutMs=${staleTraceTimeoutMs}, staleSweepMs=${staleSweepIntervalMs}, flushRetryCount=${flushRetryCount}, flushRetryBaseDelayMs=${flushRetryBaseDelayMs})`,
      );
    },

    async stop() {
      cleanup?.();
      cleanup = null;

      // End all open traces before flushing.
      for (const [sessionKey, active] of activeTraces) {
        closeActiveTrace(active, `service stop sessionKey=${sessionKey}`);
      }
      activeTraces.clear();
      sessionByAgentId.clear();
      lastActiveSessionKey = undefined;

      // Drain any already-scheduled flushes before the final flush.
      await flushQueue.catch(() => undefined);

      if (client) {
        await flushWithRetry("service stop");
        client = null;
      }

      log.info(
        `opik: exporter metrics flushSuccesses=${exporterMetrics.flushSuccesses} flushFailures=${exporterMetrics.flushFailures} flushRetries=${exporterMetrics.flushRetries} traceUpdateErrors=${exporterMetrics.traceUpdateErrors} traceEndErrors=${exporterMetrics.traceEndErrors} spanUpdateErrors=${exporterMetrics.spanUpdateErrors} spanEndErrors=${exporterMetrics.spanEndErrors}`,
      );
    },
  } satisfies OpenClawPluginService;
}
