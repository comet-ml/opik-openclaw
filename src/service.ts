import type {
  DiagnosticEventPayload,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import { Opik, type Span, type Trace } from "opik";
import { createAttachmentUploader } from "./service/attachment-uploader.js";
import { registerLlmHooks } from "./service/hooks/llm.js";
import { registerSubagentHooks } from "./service/hooks/subagent.js";
import { registerToolHooks } from "./service/hooks/tool.js";
import {
  ATTACHMENT_UPLOADS_ENABLED,
  DEFAULT_ATTACHMENT_BASE_URL,
  DEFAULT_FLUSH_RETRY_BASE_DELAY_MS,
  DEFAULT_FLUSH_RETRY_COUNT,
  DEFAULT_STALE_SWEEP_INTERVAL_MS,
  DEFAULT_STALE_TRACE_TIMEOUT_MS,
  MAX_FLUSH_RETRY_DELAY_MS,
  OPIK_PLUGIN_ID,
} from "./service/constants.js";
import {
  asNonEmptyString,
  asNonNegativeNumber,
  formatError,
  hasCostUsageFields,
  hasUsageFields,
  mapUsageToOpikTokens,
  mergeDefinedConfig,
  normalizeProvider,
  resolveChannelId,
  resolveRunId,
  resolveToolCallId,
  resolveTrigger,
  sleep,
} from "./service/helpers.js";
import { sanitizeStringForOpik, sanitizeValueForOpik } from "./service/payload-sanitizer.js";
import { parseOpikPluginConfig, type ActiveTrace, type OpikPluginConfig } from "./types.js";

type ServiceLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

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
  let attachmentBaseUrl = DEFAULT_ATTACHMENT_BASE_URL;

  let flushQueue: Promise<void> = Promise.resolve();
  const attachmentUploader = createAttachmentUploader({
    getClient: () => client,
    getAttachmentBaseUrl: () => attachmentBaseUrl,
    onWarn: (message) => log.warn(message),
    formatError,
    attachmentsEnabled: ATTACHMENT_UPLOADS_ENABLED,
  });

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

  function applyContextMeta(active: ActiveTrace, ctx: Record<string, unknown>): void {
    const explicitChannelId = asNonEmptyString(ctx.channelId);
    const fallbackChannel = asNonEmptyString(ctx.messageProvider);
    if (explicitChannelId) {
      active.channelId = explicitChannelId;
    } else if (!active.channelId && fallbackChannel) {
      active.channelId = fallbackChannel;
    }
    const trigger = resolveTrigger(ctx);
    if (trigger) active.trigger = trigger;
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
      ...(active.channelId ? { channel: active.channelId, channelId: active.channelId } : {}),
      ...(active.trigger ? { trigger: active.trigger } : {}),
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
    id: OPIK_PLUGIN_ID,
    async start(ctx) {
      log = {
        info: ctx.logger.info.bind(ctx.logger),
        warn: ctx.logger.warn.bind(ctx.logger),
      };
      attachmentUploader.reset();

      const runtimeCfg = parseOpikPluginConfig(ctx.config);
      const opikCfg = mergeDefinedConfig(runtimeCfg, pluginConfig);

      if (!opikCfg?.enabled) {
        return;
      }

      const apiKey = opikCfg.apiKey ?? process.env.OPIK_API_KEY;
      const apiUrl = opikCfg.apiUrl ?? process.env.OPIK_URL_OVERRIDE;
      const projectName = opikCfg.projectName ?? process.env.OPIK_PROJECT_NAME ?? "openclaw";
      const workspaceName = opikCfg.workspaceName ?? process.env.OPIK_WORKSPACE ?? "default";
      const tags = opikCfg.tags ?? ["openclaw"];
      attachmentBaseUrl = (apiUrl ?? DEFAULT_ATTACHMENT_BASE_URL).replace(/\/+$/, "");

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

      registerLlmHooks({
        api,
        getClient: () => client,
        activeTraces,
        tags,
        projectName,
        rememberSessionCorrelation,
        closeActiveTrace,
        forgetSessionCorrelation,
        applyContextMeta,
        safeSpanUpdate,
        safeSpanEnd,
        scheduleMediaAttachmentUploads: attachmentUploader.scheduleMediaAttachmentUploads,
        warn: (message) => log.warn(message),
        formatError,
      });

      registerToolHooks({
        api,
        getClient: () => client,
        activeTraces,
        sessionByAgentId,
        getLastActiveSessionKey: () => lastActiveSessionKey,
        rememberSessionCorrelation,
        warnMissingAfterToolSessionKey,
        nextSpanSeq: () => ++spanSeq,
        safeSpanUpdate,
        safeSpanEnd,
        scheduleMediaAttachmentUploads: attachmentUploader.scheduleMediaAttachmentUploads,
        projectName,
        warn: (message) => log.warn(message),
        formatError,
      });

      registerSubagentHooks({
        api,
        getClient: () => client,
        rememberSessionCorrelation,
        resolveSubagentHostTrace,
        safeSpanUpdate,
        safeSpanEnd,
        warn: (message) => log.warn(message),
        formatError,
      });

      // =====================================================================
      // Hook: tool_result_persist — sanitize persisted tool messages
      // =====================================================================
      api.on("tool_result_persist", (event) => {
        try {
          const eventObj = event as Record<string, unknown>;
          const message = eventObj.message;
          if (!message || typeof message !== "object") return;

          const sanitizedMessage = sanitizeValueForOpik(message);
          if (sanitizedMessage !== message) {
            return { message: sanitizedMessage };
          }
        } catch (err) {
          log.warn(`opik: tool_result_persist failed: ${formatError(err)}`);
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

        applyContextMeta(active, agentCtx as Record<string, unknown>);
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
          error: typeof event.error === "string" ? sanitizeStringForOpik(event.error) : event.error,
          durationMs: event.durationMs,
          messages: (sanitizeValueForOpik(
            ((event as Record<string, unknown>).messages as unknown[]) ?? [],
          ) as unknown[]) ?? [],
        };

        attachmentUploader.scheduleMediaAttachmentUploads({
          entityType: "trace",
          entity: active.trace,
          projectName,
          reason: `agent_end sessionKey=${sessionKey}`,
          payloads: [event.error, (event as Record<string, unknown>).messages],
        });

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
        if (evt.provider) active.costMeta.provider = normalizeProvider(evt.provider) ?? evt.provider;
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
      await attachmentUploader.waitForUploads();

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
