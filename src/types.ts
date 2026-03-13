import type { Span, Trace } from "opik";

export type OpikPluginConfig = {
  enabled?: boolean;
  apiKey?: string;
  apiUrl?: string;
  projectName?: string;
  workspaceName?: string;
  tags?: string[];
  toolResultPersistSanitizeEnabled?: boolean;
  staleTraceTimeoutMs?: number;
  staleSweepIntervalMs?: number;
  staleTraceCleanupEnabled?: boolean;
  flushRetryCount?: number;
  flushRetryBaseDelayMs?: number;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function parseOpikPluginConfig(raw: unknown): OpikPluginConfig {
  const cfg = asObject(raw);
  const tagsRaw = cfg.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : undefined,
    apiKey: asOptionalString(cfg.apiKey),
    apiUrl: asOptionalString(cfg.apiUrl),
    projectName: asOptionalTrimmedString(cfg.projectName),
    workspaceName: asOptionalTrimmedString(cfg.workspaceName),
    tags,
    toolResultPersistSanitizeEnabled:
      typeof cfg.toolResultPersistSanitizeEnabled === "boolean"
        ? cfg.toolResultPersistSanitizeEnabled
        : undefined,
    staleTraceTimeoutMs: asOptionalNumber(cfg.staleTraceTimeoutMs),
    staleSweepIntervalMs: asOptionalNumber(cfg.staleSweepIntervalMs),
    staleTraceCleanupEnabled:
      typeof cfg.staleTraceCleanupEnabled === "boolean" ? cfg.staleTraceCleanupEnabled : undefined,
    flushRetryCount: asOptionalNumber(cfg.flushRetryCount),
    flushRetryBaseDelayMs: asOptionalNumber(cfg.flushRetryBaseDelayMs),
  };
}

/** Active trace state for a single agent run, keyed by sessionKey. */
export type ActiveTrace = {
  trace: Trace;
  llmSpan: Span | null;
  toolSpans: Map<string, Span>;
  subagentSpans: Map<string, Span>;
  startedAt: number;
  lastActivityAt: number;
  /** Cost metadata accumulated from model.usage diagnostic events. */
  costMeta: {
    costUsd?: number;
    contextLimit?: number;
    contextUsed?: number;
    model?: string;
    provider?: string;
    durationMs?: number;
    usageInput?: number;
    usageOutput?: number;
    usageCacheRead?: number;
    usageCacheWrite?: number;
    usageTotal?: number;
  };
  /** Accumulated usage from llm_output events. */
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  /** Last known model name from hooks or diagnostics. */
  model?: string;
  /** Last known provider from hooks or diagnostics. */
  provider?: string;
  /** Last known channel id from hook context. */
  channelId?: string;
  /** Last known trigger from hook context. */
  trigger?: string;
  /** Output accumulated from llm_output. */
  output?: { output: string; lastAssistant?: unknown };
  /** Data stored by agent_end for deferred finalization. */
  agentEnd?: {
    success: boolean;
    error?: string;
    durationMs?: number;
    messages: unknown[];
  };
};
