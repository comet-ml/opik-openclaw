import { randomUUID } from "node:crypto";
import { describe, test } from "vitest";
import { createOpikService } from "./service.js";

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => void;

const requiredEnv = ["OPIK_API_KEY", "OPIK_URL_OVERRIDE"] as const;
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
const e2eEnabled = process.env.OPIK_E2E === "1";

if (e2eEnabled && missingEnv.length > 0) {
  throw new Error(`Missing required env for Opik E2E: ${missingEnv.join(", ")}`);
}

const describeMaybe = e2eEnabled ? describe : describe.skip;

describeMaybe("opik service e2e", () => {
  test(
    "exports a trace with tool + subagent events",
    { timeout: 60_000 },
    async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any, { enabled: true });

      await service.start(createServiceContext() as any);

      const sessionKey = `e2e-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      const toolCallId = `tool-${randomUUID()}`;
      const childSessionKey = `child-${randomUUID()}`;

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-4o-mini",
          provider: "openai",
          prompt: "Ping",
          systemPrompt: "You are an integration test.",
          imagesCount: 0,
          sessionId: `session-${randomUUID()}`,
          runId,
          historyMessages: [],
        },
        {
          sessionKey,
          agentId: "agent-e2e",
          messageProvider: "test",
          sessionId: `session-${randomUUID()}`,
          runId,
          channelId: "discord",
          trigger: "cron",
        },
      );

      invokeHook(
        hooks,
        "before_tool_call",
        {
          toolName: "web_search",
          params: { query: "opik e2e" },
          toolCallId,
          runId,
        },
        {
          sessionKey,
          agentId: "agent-e2e",
          toolCallId,
          runId,
          sessionId: `session-${randomUUID()}`,
        },
      );

      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "web_search",
          result: { ok: true },
          toolCallId,
          runId,
          durationMs: 12,
        },
        {
          sessionKey,
          agentId: "agent-e2e",
          toolCallId,
          runId,
          sessionId: `session-${randomUUID()}`,
        },
      );

      invokeHook(
        hooks,
        "subagent_spawning",
        {
          childSessionKey,
          agentId: "agent-sub",
          label: "sub-e2e",
          mode: "assistant",
          requester: "integration",
          threadRequested: true,
        },
        {
          requesterSessionKey: sessionKey,
          childSessionKey,
          runId,
        },
      );

      invokeHook(
        hooks,
        "subagent_spawned",
        {
          childSessionKey,
          agentId: "agent-sub",
          mode: "assistant",
          threadRequested: true,
          runId,
        },
        {
          requesterSessionKey: sessionKey,
          childSessionKey,
          runId,
        },
      );

      invokeHook(
        hooks,
        "subagent_ended",
        {
          targetSessionKey: childSessionKey,
          targetKind: "assistant",
          outcome: "success",
          reason: "integration",
          endedAt: new Date().toISOString(),
          runId,
        },
        {
          requesterSessionKey: sessionKey,
          childSessionKey,
          runId,
        },
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4o-mini",
          provider: "openai",
          assistantTexts: ["Pong"],
          lastAssistant: "Pong",
          usage: { input: 1, output: 1, total: 2 },
        },
        {
          sessionKey,
          agentId: "agent-e2e",
          runId,
          channelId: "discord",
          trigger: "cron",
        },
      );

      invokeHook(
        hooks,
        "agent_end",
        {
          success: true,
          durationMs: 25,
        },
        {
          sessionKey,
          agentId: "agent-e2e",
          runId,
          channelId: "discord",
          trigger: "cron",
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      await service.stop?.({} as any);
    },
  );
});

function createApi() {
  const hooks: Record<string, HookHandler> = {};
  const api = {
    on: (hookName: string, handler: HookHandler) => {
      hooks[hookName] = handler;
    },
    registerService: () => undefined,
  };

  return { api, hooks };
}

function createServiceContext() {
  return {
    config: { opik: { enabled: true } },
    logger: {
      info: () => undefined,
      warn: () => undefined,
    },
    stateDir: "/tmp/opik-e2e",
  };
}

function invokeHook(
  hooks: Record<string, HookHandler>,
  name: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) {
  const hook = hooks[name];
  if (!hook) throw new Error(`Hook "${name}" not registered`);
  hook(event, ctx);
}
