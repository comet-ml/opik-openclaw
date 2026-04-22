import type {
  DiagnosticEventPayload,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { Opik, Span, Trace } from "opik";
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
  OPIK_CREATED_FROM,
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

let client: Opik | null = null;
const activeTraces = new Map<string, ActiveTrace>();
const subagentSpanHosts = new Map<
  string,
  { hostSessionKey: string; active: ActiveTrace; span: Span }
>();
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
let currentProjectName = "openclaw";
let currentTags = ["openclaw"];
let toolResultPersistSanitizeEnabled = false;
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

function resetSharedRuntimeState(): void {
  cleanup?.();
  client = null;
  activeTraces.clear();
  subagentSpanHosts.clear();
  sessionByAgentId.clear();
  cleanup = null;
  spanSeq = 0;
  lastActiveSessionKey = undefined;
  warnedMissingAfterToolSessionKey = false;
  staleTraceTimeoutMs = DEFAULT_STALE_TRACE_TIMEOUT_MS;
  staleSweepIntervalMs = DEFAULT_STALE_SWEEP_INTERVAL_MS;
  staleTraceCleanupEnabled = true;
  flushRetryCount = DEFAULT_FLUSH_RETRY_COUNT;
  flushRetryBaseDelayMs = DEFAULT_FLUSH_RETRY_BASE_DELAY_MS;
  attachmentBaseUrl = DEFAULT_ATTACHMENT_BASE_URL;
  currentProjectName = "openclaw";
  currentTags = ["openclaw"];
  toolResultPersistSanitizeEnabled = false;
  flushQueue = Promise.resolve();
  attachmentUploader.reset();
  exporterMetrics.traceUpdateErrors = 0;
  exporterMetrics.traceEndErrors = 0;
  exporterMetrics.spanUpdateErrors = 0;
  exporterMetrics.spanEndErrors = 0;
  exporterMetrics.flushSuccesses = 0;
  exporterMetrics.flushFailures = 0;
  exporterMetrics.flushRetries = 0;
}

export type OpikRuntimeService = OpenClawPluginService & {
  registerHooks: () => void;
};

export function createOpikService(
  api: OpenClawPluginApi,
  pluginConfig: OpikPluginConfig = {},
): OpikRuntimeService {
  let hooksRegistered = false;

  function rememberSessionCorrelation(sessionKey: string, agentId?: unknown): void {
    lastActiveSessionKey = sessionKey;
    if (typeof agentId === "string" && agentId.length > 0) {
      sessionByAgentId.set(agentId, sessionKey);
    }
  }

  function resolveSessionKey(
    ctx: Record<string, unknown>,
    sessionIdOverride?: string,
  ): string | undefined {
    const explicitSessionKey = asNonEmptyString(ctx.sessionKey);
    if (explicitSessionKey) return explicitSessionKey;

    const sessionId = sessionIdOverride ?? asNonEmptyString(ctx.sessionId);
    if (sessionId) return sessionId;

    const agentId = asNonEmptyString(ctx.agentId);
    if (agentId) {
      const mappedSessionKey = sessionByAgentId.get(agentId);
      if (mappedSessionKey) return mappedSessionKey;
    }

    return lastActiveSessionKey;
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

  function rememberSubagentSpanHost(
    sessionKey: string,
    hostSessionKey: string,
    active: ActiveTrace,
    span: Span,
  ): void {
    subagentSpanHosts.set(sessionKey, { hostSessionKey, active, span });
  }

  function getSubagentSpanHost(
    sessionKey: string,
  ): { hostSessionKey: string; active: ActiveTrace; span: Span } | undefined {
    return subagentSpanHosts.get(sessionKey);
  }

  function forgetSubagentSpanHost(sessionKey: string): void {
    subagentSpanHosts.delete(sessionKey);
  }

  function forgetSubagentSpanHostsByActive(active: ActiveTrace): void {
    for (const [sessionKey, spanHost] of subagentSpanHosts) {
      if (spanHost.active === active) {
        subagentSpanHosts.delete(sessionKey);
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
    forgetSubagentSpanHostsByActive(active);

    // Clear deferred finalization state so stale microtasks no-op.
    active.agentEnd = undefined;
    active.output = undefined;

    safeTraceEnd(active.trace, reason);
  }

  function resolveSessionSpanContainer(
    sessionKey: string,
  ): { sessionKey: string; active: ActiveTrace; parent: Trace | Span } | undefined {
    const spanHost = getSubagentSpanHost(sessionKey);
    if (spanHost) {
      return {
        sessionKey: spanHost.hostSessionKey,
        active: spanHost.active,
        parent: spanHost.span,
      };
    }

    const active = activeTraces.get(sessionKey);
    if (active) {
      return { sessionKey, active, parent: active.trace };
    }

    return undefined;
  }

  function resolveSubagentSpanContainer(params: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    targetSessionKey?: string;
  }): { sessionKey: string; active: ActiveTrace; parent: Trace | Span } | undefined {
    if (params.requesterSessionKey) {
      const requesterContainer = resolveSessionSpanContainer(params.requesterSessionKey);
      if (requesterContainer) {
        return requesterContainer;
      }
    }

    const candidates = [params.childSessionKey, params.targetSessionKey];
    for (const key of candidates) {
      if (!key) continue;
      const active = activeTraces.get(key);
      if (active) {
        return { sessionKey: key, active, parent: active.trace };
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

  function trimOrUndefined(value: string | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  async function validateProjectTarget(params: {
    client: unknown;
    projectName: string;
    workspaceName: string;
  }): Promise<void> {
    const retrieveProject =
      typeof params.client === "object" &&
      params.client !== null &&
      "projects" in params.client &&
      typeof (params.client as { projects?: { retrieveProject?: unknown } }).projects?.retrieveProject ===
        "function"
        ? ((params.client as {
            projects: {
              retrieveProject: (
                request: { name: string },
                requestOptions?: { workspaceName?: string },
              ) => Promise<unknown>;
            };
          }).projects.retrieveProject)
        : undefined;
    if (!retrieveProject) return;

    try {
      await retrieveProject(
        { name: params.projectName },
        { workspaceName: params.workspaceName },
      );
    } catch (err) {
      const statusCode =
        typeof err === "object" && err !== null && "statusCode" in err
          ? (err as { statusCode?: unknown }).statusCode
          : undefined;

      if (statusCode === 404) {
        log.warn(
          `opik: configured project "${params.projectName}" was not found in workspace "${params.workspaceName}"; traces may not appear until the project exists or the plugin is reconfigured`,
        );
        return;
      }

      if (statusCode === 403) {
        log.warn(
          `opik: could not access project "${params.projectName}" in workspace "${params.workspaceName}" (forbidden); verify the API key and workspace permissions`,
        );
        return;
      }

      log.warn(
        `opik: could not validate project "${params.projectName}" in workspace "${params.workspaceName}": ${formatError(err)}`,
      );
    }
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
      created_from: OPIK_CREATED_FROM,
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
    forgetSubagentSpanHostsByActive(active);
    activeTraces.delete(sessionKey);
    forgetSessionCorrelation(sessionKey);
    scheduleFlush(`trace-finalized sessionKey=${sessionKey}`);
  }

  function registerHooks(): void {
    if (hooksRegistered) {
      return;
    }
    hooksRegistered = true;

    registerLlmHooks({
      api,
      getClient: () => client,
      activeTraces,
      getTags: () => currentTags,
      getProjectName: () => currentProjectName,
      rememberSessionCorrelation,
      closeActiveTrace,
      forgetSessionCorrelation,
      applyContextMeta,
      safeSpanUpdate,
      safeSpanEnd,
      scheduleMediaAttachmentUploads: attachmentUploader.scheduleMediaAttachmentUploads,
      warn: (message) => log.warn(message),
      formatError,
      resolveSessionKey,
    });

    registerToolHooks({
      api,
      getClient: () => client,
      activeTraces,
      sessionByAgentId,
      getLastActiveSessionKey: () => lastActiveSessionKey,
      rememberSessionCorrelation,
      resolveSessionSpanContainer,
      warnMissingAfterToolSessionKey,
      nextSpanSeq: () => ++spanSeq,
      safeSpanUpdate,
      safeSpanEnd,
      scheduleMediaAttachmentUploads: attachmentUploader.scheduleMediaAttachmentUploads,
      getProjectName: () => currentProjectName,
      warn: (message) => log.warn(message),
      formatError,
    });

    registerSubagentHooks({
      api,
      getClient: () => client,
      rememberSessionCorrelation,
      resolveSubagentSpanContainer,
      getSubagentSpanHost,
      rememberSubagentSpanHost,
      forgetSubagentSpanHost,
      safeSpanUpdate,
      safeSpanEnd,
      warn: (message) => log.warn(message),
      formatError,
    });

    api.on("tool_result_persist", (event) => {
      if (!toolResultPersistSanitizeEnabled) {
        return;
      }

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

    api.on("agent_end", (event, agentCtx) => {
      const agentCtxObj = agentCtx as Record<string, unknown>;
      const sessionKey = resolveSessionKey(agentCtxObj);
      if (!sessionKey) {
        log.warn("opik: agent_end missing sessionKey");
        return;
      }
      rememberSessionCorrelation(sessionKey, agentCtx.agentId);

      const active = activeTraces.get(sessionKey);
      if (!active) {
        log.warn(
          `opik: agent_end missing active trace sessionKey=${sessionKey} activeTraces=${activeTraces.size}`,
        );
        return;
      }

      applyContextMeta(active, agentCtx as Record<string, unknown>);
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
        projectName: currentProjectName,
        reason: `agent_end sessionKey=${sessionKey}`,
        payloads: [
          event.error,
          ((event as Record<string, unknown>).messages as unknown[] | undefined)?.at(-1),
        ],
      });

      const traceRef = active.trace;
      queueMicrotask(() => {
        const current = activeTraces.get(sessionKey);
        if (current && current.trace === traceRef) finalizeTrace(sessionKey);
      });
    });
  }

  const service: OpikRuntimeService = {
    id: OPIK_PLUGIN_ID,
    registerHooks,
    async start(ctx) {
      registerHooks();
      resetSharedRuntimeState();
      log = {
        info: ctx.logger.info.bind(ctx.logger),
        warn: ctx.logger.warn.bind(ctx.logger),
      };
      currentProjectName = pluginConfig.projectName?.trim() || "openclaw";
      currentTags = pluginConfig.tags ?? ["openclaw"];
      toolResultPersistSanitizeEnabled = pluginConfig.toolResultPersistSanitizeEnabled === true;

      const runtimeCfg = parseOpikPluginConfig(ctx.config);
      const opikCfg = mergeDefinedConfig(runtimeCfg, pluginConfig);

      if (!opikCfg?.enabled) {
        return;
      }

      const apiKey = opikCfg.apiKey ?? process.env.OPIK_API_KEY;
      const apiUrl = opikCfg.apiUrl ?? process.env.OPIK_URL_OVERRIDE;
      const projectName = opikCfg.projectName ?? trimOrUndefined(process.env.OPIK_PROJECT_NAME) ?? "openclaw";
      const workspaceName =
        opikCfg.workspaceName ?? trimOrUndefined(process.env.OPIK_WORKSPACE) ?? "default";
      const tags = opikCfg.tags ?? ["openclaw"];
      currentProjectName = projectName;
      currentTags = tags;
      attachmentBaseUrl = (apiUrl ?? DEFAULT_ATTACHMENT_BASE_URL).replace(/\/+$/, "");
      toolResultPersistSanitizeEnabled = opikCfg.toolResultPersistSanitizeEnabled === true;

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

      const { disableLogger, Opik } = await import("opik");
      // Suppress Opik SDK tslog console output once the exporter actually starts.
      disableLogger();
      client = new Opik({
        apiKey,
        ...(apiUrl ? { apiUrl } : {}),
        projectName,
        workspaceName,
      });

      await validateProjectTarget({
        client,
        projectName,
        workspaceName,
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
                forgetSubagentSpanHostsByActive(active);
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
      toolResultPersistSanitizeEnabled = false;

      log.info(
        `opik: exporter metrics flushSuccesses=${exporterMetrics.flushSuccesses} flushFailures=${exporterMetrics.flushFailures} flushRetries=${exporterMetrics.flushRetries} traceUpdateErrors=${exporterMetrics.traceUpdateErrors} traceEndErrors=${exporterMetrics.traceEndErrors} spanUpdateErrors=${exporterMetrics.spanUpdateErrors} spanEndErrors=${exporterMetrics.spanEndErrors}`,
      );
    },
  };

  return service;
}
