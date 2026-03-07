import type { ActiveTrace, OpikPluginConfig } from "../types.js";

/** Map OpenClaw usage fields to Opik's expected token field names. */
export function mapUsageToOpikTokens(
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

export function mergeDefinedConfig(
  base: OpikPluginConfig,
  override: OpikPluginConfig,
): OpikPluginConfig {
  const merged: OpikPluginConfig = { ...base };
  const mutable = merged as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    mutable[key] = value;
  }
  return merged;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveChannelId(ctx: Record<string, unknown>): string | undefined {
  return asNonEmptyString(ctx.channelId) ?? asNonEmptyString(ctx.messageProvider);
}

export function resolveTrigger(ctx: Record<string, unknown>): string | undefined {
  return asNonEmptyString(ctx.trigger);
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function normalizeProvider(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;

  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  if (
    normalized === "openai-codex" ||
    normalized === "openai_codex" ||
    normalized === "codex" ||
    (normalized.includes("openai") && normalized.includes("codex"))
  ) {
    return "openai";
  }

  return normalized;
}

export function hasUsageFields(usage: ActiveTrace["usage"]): boolean {
  return (
    usage.input != null ||
    usage.output != null ||
    usage.cacheRead != null ||
    usage.cacheWrite != null ||
    usage.total != null
  );
}

export function hasCostUsageFields(costMeta: ActiveTrace["costMeta"]): boolean {
  return (
    costMeta.usageInput != null ||
    costMeta.usageOutput != null ||
    costMeta.usageCacheRead != null ||
    costMeta.usageCacheWrite != null ||
    costMeta.usageTotal != null
  );
}

/**
 * Derive a unique agent identifier from the session key.
 * Session keys follow the format `agent:<scope>:<name>` (e.g. `agent:yariv:main`).
 * Returns `<scope>/<name>` to distinguish agents with the same name but different scopes.
 * Falls back to the raw agentId if the session key doesn't match the expected format.
 */
export function resolveUniqueAgentId(
  sessionKey: string | undefined,
  agentId: unknown,
): string | undefined {
  if (sessionKey) {
    const parts = sessionKey.split(":");
    if (parts.length >= 3 && parts[0] === "agent") {
      return sessionKey;
    }
  }
  return asNonEmptyString(agentId);
}

export function resolveToolCallId(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  return asNonEmptyString(event.toolCallId) ?? asNonEmptyString(ctx.toolCallId);
}

export function resolveRunId(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  return asNonEmptyString(event.runId) ?? asNonEmptyString(ctx.runId);
}

export function formatError(err: unknown): string {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
