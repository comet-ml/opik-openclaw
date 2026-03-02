import type {
  DiagnosticEventPayload,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import { Opik } from "opik";
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

/** Stale trace threshold: 5 minutes of inactivity. */
const STALE_TRACE_MS = 5 * 60 * 1000;

/** Cleanup sweep interval: 60 seconds. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** End all open child spans (tool spans + LLM span) on an active trace. */
function endChildSpans(active: ActiveTrace): void {
  for (const [, toolSpan] of active.toolSpans) {
    try {
      toolSpan.end();
    } catch {
      /* ignore */
    }
  }
  active.toolSpans.clear();

  if (active.llmSpan) {
    try {
      active.llmSpan.end();
    } catch {
      /* ignore */
    }
    active.llmSpan = null;
  }
}

/** Close all open spans and the trace on an ActiveTrace entry. */
function closeActiveTrace(active: ActiveTrace): void {
  endChildSpans(active);

  // Clear deferred finalization state so stale microtasks no-op
  active.agentEnd = undefined;
  active.output = undefined;

  try {
    active.trace.end();
  } catch {
    /* ignore */
  }
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

  function warnMissingAfterToolSessionKey(
    logger: { warn: (message: string) => void },
    fallbackMode: string,
  ): void {
    if (warnedMissingAfterToolSessionKey) return;
    warnedMissingAfterToolSessionKey = true;
    logger.warn(
      `opik: after_tool_call missing sessionKey; using ${fallbackMode} fallback correlation (upgrade OpenClaw for strict context propagation)`,
    );
  }

  /** Consolidate output + metadata into a single trace.update() + trace.end(). */
  function finalizeTrace(sessionKey: string): void {
    const active = activeTraces.get(sessionKey);
    if (!active) return;

    // End any remaining open child spans (LLM span if llm_output didn't fire)
    endChildSpans(active);

    // Build output: prefer llm_output data, fall back to last assistant from messages
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

    // Prefer accumulated llm_output usage, fall back to diagnostic costMeta usage
    if (active.usage.input != null || active.usage.output != null) {
      metadata.usage = { ...active.usage };
    } else if (active.costMeta.usageInput != null || active.costMeta.usageOutput != null) {
      metadata.usage = {
        input: active.costMeta.usageInput,
        output: active.costMeta.usageOutput,
        cacheRead: active.costMeta.usageCacheRead,
        cacheWrite: active.costMeta.usageCacheWrite,
        total: active.costMeta.usageTotal,
      };
    }

    if (agentEnd?.error) metadata.error = agentEnd.error;

    active.trace.update({
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
    });

    active.trace.end();
    activeTraces.delete(sessionKey);
    forgetSessionCorrelation(sessionKey);
    client?.flush().catch(() => undefined);
  }

  return {
    id: "opik",
    async start(ctx) {
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

        // Close any pre-existing trace for this session to avoid leaks
        const existing = activeTraces.get(sessionKey);
        if (existing) {
          closeActiveTrace(existing);
          activeTraces.delete(sessionKey);
          forgetSessionCorrelation(sessionKey);
        }

        const trace = client.trace({
          name: `${event.model} \u00b7 ${agentCtx.messageProvider ?? "unknown"}`,
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

        const llmSpan = trace.span({
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

        const now = Date.now();
        activeTraces.set(sessionKey, {
          trace,
          llmSpan,
          toolSpans: new Map(),
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

        // Trace output uses joined text for readability; LLM span retains raw array for debugging
        active.llmSpan.update({
          output: {
            assistantTexts: event.assistantTexts,
            lastAssistant: event.lastAssistant,
          },
          usage: mapUsageToOpikTokens(event.usage),
          model: event.model,
          provider: event.provider,
        });

        // Store output for deferred trace-level finalization
        active.output = {
          output: event.assistantTexts.join("\n\n"),
          lastAssistant: event.lastAssistant,
        };

        // Accumulate usage + model on the ActiveTrace for finalization metadata
        if (event.usage) {
          active.usage = { ...active.usage, ...event.usage };
        }
        active.model = event.model;
        active.provider = event.provider;

        active.llmSpan.end();
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

        const toolSpan = active.trace.span({
          name: event.toolName,
          type: "tool",
          input: event.params,
        });

        // Use a monotonic counter to avoid collisions within the same tick
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
            warnMissingAfterToolSessionKey(ctx.logger, fallbackMode);
          }
        }
        if (!sessionKey) return;
        rememberSessionCorrelation(sessionKey, toolCtx.agentId);

        const active = activeTraces.get(sessionKey);
        if (!active) return;

        active.lastActivityAt = Date.now();

        // Find the matching tool span (FIFO: oldest span for this tool name)
        let matchedKey: string | undefined;
        let matchedSpan: import("opik").Span | undefined;
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
          matchedSpan.update(spanUpdate);
        }

        matchedSpan.end();
        active.toolSpans.delete(matchedKey);
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

        // Close any orphaned tool spans (synchronous)
        for (const [, toolSpan] of active.toolSpans) {
          try {
            toolSpan.end();
          } catch {
            /* ignore */
          }
        }
        active.toolSpans.clear();

        // Store agent-end data for deferred finalization
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

        // Accumulate cost metadata — will be merged into trace at agent_end
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
      const sweepInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, active] of activeTraces) {
          if (now - active.lastActivityAt > STALE_TRACE_MS) {
            endChildSpans(active);

            // Mark trace as stale before closing
            active.trace.update({
              metadata: { staleCleanup: true },
              errorInfo: {
                exceptionType: "StaleTrace",
                message: "Trace exceeded maximum inactivity threshold and was forcibly ended",
                traceback: `Stale trace for sessionKey=${key}, inactive=${now - active.lastActivityAt}ms`,
              },
            });

            try {
              active.trace.end();
            } catch {
              /* ignore */
            }
            activeTraces.delete(key);
            forgetSessionCorrelation(key);
          }
        }

        // Flush when no active traces remain
        if (activeTraces.size === 0) {
          client?.flush().catch(() => undefined);
        }
      }, SWEEP_INTERVAL_MS);

      // =====================================================================
      // Wire cleanup
      // =====================================================================
      cleanup = () => {
        unsubscribeDiagnostics();
        clearInterval(sweepInterval);
      };

      ctx.logger.info(`opik: exporting traces to project "${projectName}"`);
    },

    async stop() {
      cleanup?.();
      cleanup = null;

      // End all open traces before flushing
      for (const [, active] of activeTraces) {
        closeActiveTrace(active);
      }
      activeTraces.clear();
      sessionByAgentId.clear();
      lastActiveSessionKey = undefined;

      if (client) {
        await client.flush().catch(() => undefined);
        client = null;
      }
    },
  } satisfies OpenClawPluginService;
}
