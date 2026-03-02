import type { Span, Trace } from "opik";

export type OpikPluginConfig = {
  enabled?: boolean;
  apiKey?: string;
  apiUrl?: string;
  projectName?: string;
  workspaceName?: string;
  tags?: string[];
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
    projectName: asOptionalString(cfg.projectName),
    workspaceName: asOptionalString(cfg.workspaceName),
    tags,
  };
}

/** Active trace state for a single agent run, keyed by sessionKey. */
export type ActiveTrace = {
  trace: Trace;
  llmSpan: Span | null;
  toolSpans: Map<string, Span>;
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
