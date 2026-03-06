import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Opik, Span, Trace } from "opik";
import type { ActiveTrace } from "../../types.js";
import { OPIK_CREATED_FROM } from "../constants.js";
import {
  mapUsageToOpikTokens,
  normalizeProvider,
  resolveChannelId,
  resolveTrigger,
} from "../helpers.js";
import { sanitizeValueForOpik } from "../payload-sanitizer.js";

type LlmHooksDeps = {
  api: OpenClawPluginApi;
  getClient: () => Opik | null;
  activeTraces: Map<string, ActiveTrace>;
  tags: string[];
  projectName: string;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  closeActiveTrace: (active: ActiveTrace, reason: string) => void;
  forgetSessionCorrelation: (sessionKey: string) => void;
  applyContextMeta: (active: ActiveTrace, ctx: Record<string, unknown>) => void;
  safeSpanUpdate: (span: Span, payload: Record<string, unknown>, reason: string) => void;
  safeSpanEnd: (span: Span, reason: string) => void;
  scheduleMediaAttachmentUploads: (params: {
    entityType: "trace" | "span";
    entity: unknown;
    projectName: string;
    reason: string;
    payloads: unknown[];
  }) => void;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export function registerLlmHooks(deps: LlmHooksDeps): void {
  deps.api.on("llm_input", (event, agentCtx) => {
    const client = deps.getClient();
    if (!client) return;
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, agentCtx.agentId);
    const normalizedProvider = normalizeProvider(event.provider) ?? event.provider;
    const agentCtxObj = agentCtx as Record<string, unknown>;
    const channelId = resolveChannelId(agentCtxObj);
    const trigger = resolveTrigger(agentCtxObj);

    const existing = deps.activeTraces.get(sessionKey);
    if (existing) {
      deps.closeActiveTrace(existing, `replace active trace sessionKey=${sessionKey}`);
      deps.activeTraces.delete(sessionKey);
      deps.forgetSessionCorrelation(sessionKey);
    }

    let trace: Trace;
    try {
      const sanitizedTraceInput = sanitizeValueForOpik({
        prompt: event.prompt,
        systemPrompt: event.systemPrompt,
        imagesCount: event.imagesCount,
      }) as Record<string, unknown>;
      trace = client.trace({
        name: `${event.model} · ${channelId ?? "unknown"}`,
        threadId: sessionKey,
        input: sanitizedTraceInput,
        metadata: {
          created_from: OPIK_CREATED_FROM,
          provider: normalizedProvider,
          model: event.model,
          sessionId: event.sessionId,
          runId: event.runId,
          agentId: agentCtx.agentId,
          ...(channelId ? { channel: channelId, channelId } : {}),
          ...(trigger ? { trigger } : {}),
        },
        tags: deps.tags.length > 0 ? deps.tags : undefined,
      });
    } catch (err) {
      deps.warn(`opik: trace creation failed (sessionKey=${sessionKey}): ${deps.formatError(err)}`);
      return;
    }

    let llmSpan: Span | null = null;
    try {
      const sanitizedLlmInput = sanitizeValueForOpik({
        prompt: event.prompt,
        systemPrompt: event.systemPrompt,
        historyMessages: event.historyMessages,
        imagesCount: event.imagesCount,
      }) as Record<string, unknown>;
      llmSpan = trace.span({
        name: event.model,
        type: "llm",
        model: event.model,
        provider: normalizedProvider,
        input: sanitizedLlmInput,
      });
    } catch (err) {
      deps.warn(`opik: llm span creation failed (sessionKey=${sessionKey}): ${deps.formatError(err)}`);
    }

    const now = Date.now();
    deps.activeTraces.set(sessionKey, {
      trace,
      llmSpan,
      toolSpans: new Map(),
      subagentSpans: new Map(),
      startedAt: now,
      lastActivityAt: now,
      costMeta: {},
      usage: {},
      model: event.model,
      provider: normalizedProvider,
      channelId,
      trigger,
    });

    deps.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: trace,
      projectName: deps.projectName,
      reason: `llm_input sessionKey=${sessionKey}`,
      payloads: [event.prompt, Array.isArray(event.historyMessages) ? event.historyMessages.at(-1) : undefined],
    });
  });

  deps.api.on("llm_output", (event, agentCtx) => {
    if (!deps.getClient()) return;
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, agentCtx.agentId);
    const normalizedProvider = normalizeProvider(event.provider) ?? event.provider;

    const active = deps.activeTraces.get(sessionKey);
    if (!active?.llmSpan) return;

    deps.applyContextMeta(active, agentCtx as Record<string, unknown>);
    active.lastActivityAt = Date.now();

    const sanitizedLlmOutput = sanitizeValueForOpik({
      assistantTexts: event.assistantTexts,
      lastAssistant: event.lastAssistant,
    }) as { assistantTexts?: unknown; lastAssistant?: unknown };
    const sanitizedAssistantTexts = Array.isArray(sanitizedLlmOutput.assistantTexts)
      ? sanitizedLlmOutput.assistantTexts.filter((item): item is string => typeof item === "string")
      : [];

    deps.safeSpanUpdate(
      active.llmSpan,
      {
        output: sanitizedLlmOutput as Record<string, unknown>,
        usage: mapUsageToOpikTokens(event.usage),
        model: event.model,
        provider: normalizedProvider,
      },
      `llm_output sessionKey=${sessionKey}`,
    );

    active.output = {
      output: sanitizedAssistantTexts.join("\n\n"),
      lastAssistant: sanitizedLlmOutput.lastAssistant,
    };

    if (event.usage) {
      active.usage = { ...active.usage, ...event.usage };
    }
    active.model = event.model;
    active.provider = normalizedProvider;

    deps.safeSpanEnd(active.llmSpan, `llm_output sessionKey=${sessionKey}`);
    active.llmSpan = null;
  });
}
