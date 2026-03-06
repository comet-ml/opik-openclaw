import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — created before vi.mock() factory runs
// ---------------------------------------------------------------------------
const mockFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const opikState = vi.hoisted(() => {
  let spanIdCounter = 0;

  function createMockSpan() {
    const id = ++spanIdCounter;
    return { id, update: vi.fn(), end: vi.fn(), span: vi.fn() };
  }

  function createMockTrace() {
    const trace = {
      update: vi.fn(),
      end: vi.fn(),
      span: vi.fn((_opts?: unknown) => createMockSpan()),
    };
    return trace;
  }

  return { createMockSpan, createMockTrace, resetCounter: () => (spanIdCounter = 0) };
});

const mockOpikConstructor = vi.hoisted(() => vi.fn());
const mockTraceFn = vi.hoisted(() => vi.fn());
const mockScheduleMediaAttachmentUploads = vi.hoisted(() => vi.fn());
const mockWaitForUploads = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockResetAttachments = vi.hoisted(() => vi.fn());

vi.mock("opik", () => ({
  Opik: class {
    trace = mockTraceFn;
    flush = mockFlush;
    constructor(opts?: unknown) {
      mockOpikConstructor(opts);
    }
  },
}));

// Capture the diagnostic event listener so tests can dispatch events directly
const diagnosticListeners = vi.hoisted(() => {
  const listeners: Array<(evt: unknown) => void> = [];
  return listeners;
});

vi.mock("openclaw/plugin-sdk", () => ({
  onDiagnosticEvent: (listener: (evt: unknown) => void) => {
    diagnosticListeners.push(listener);
    return () => {
      const idx = diagnosticListeners.indexOf(listener);
      if (idx >= 0) diagnosticListeners.splice(idx, 1);
    };
  },
}));

vi.mock("./service/attachment-uploader.js", () => ({
  createAttachmentUploader: () => ({
    scheduleMediaAttachmentUploads: mockScheduleMediaAttachmentUploads,
    waitForUploads: mockWaitForUploads,
    reset: mockResetAttachments,
  }),
}));

// ---------------------------------------------------------------------------
// SUT import (after mocks)
// ---------------------------------------------------------------------------
import { createOpikService } from "./service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type MockTrace = ReturnType<typeof opikState.createMockTrace>;
type MockSpan = ReturnType<typeof opikState.createMockSpan>;

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Minimal api object matching what createOpikService expects. */
function createApi() {
  const hooks: Record<string, Function> = {};
  const api = {
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
    registerService: vi.fn(),
  };
  return { api, hooks };
}

type OpikCfg = {
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

function createServiceContext(
  opikEnabled = true,
  opikCfg: OpikCfg = { enabled: true, apiKey: "test-key" },
) {
  return {
    config: opikEnabled ? opikCfg : { ...opikCfg, enabled: false },
    logger: createLogger(),
    stateDir: "/tmp/opik-test",
  };
}

/** Invoke a captured hook with event + context. */
function invokeHook(hooks: Record<string, Function>, name: string, event: unknown, ctx: unknown) {
  const hook = hooks[name];
  if (!hook) throw new Error(`Hook "${name}" not registered`);
  return hook(event, ctx);
}

function agentCtx(sessionKey: string | undefined, extra: Record<string, unknown> = {}) {
  return { sessionKey, agentId: "agent-1", messageProvider: "telegram", ...extra };
}

function toolCtx(sessionKey: string | undefined, extra: Record<string, unknown> = {}) {
  return { sessionKey, ...extra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("opik service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    opikState.resetCounter();
    diagnosticListeners.length = 0;
    mockTraceFn.mockImplementation((_opts?: unknown) => opikState.createMockTrace());
    delete process.env.OPIK_API_KEY;
    delete process.env.OPIK_URL_OVERRIDE;
    delete process.env.OPIK_PROJECT_NAME;
    delete process.env.OPIK_WORKSPACE;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // 1. Lifecycle & config gating
  // =========================================================================
  describe("lifecycle & config gating", () => {
    test("no-ops when opik.enabled=false", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext(false) as any);

      expect(api.on).not.toHaveBeenCalled();
      expect(Object.keys(hooks)).toHaveLength(0);
      expect(mockOpikConstructor).not.toHaveBeenCalled();
    });

    test("initializes Opik client with config values", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "my-key",
          apiUrl: "https://opik.example.com",
          projectName: "my-project",
          workspaceName: "my-workspace",
        }) as any,
      );

      expect(mockOpikConstructor).toHaveBeenCalledWith({
        apiKey: "my-key",
        apiUrl: "https://opik.example.com",
        projectName: "my-project",
        workspaceName: "my-workspace",
      });
    });

    test("prefers pluginConfig over runtime service config", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any, {
        enabled: true,
        apiKey: "plugin-key",
        apiUrl: "https://plugin-opik.example.com",
        projectName: "plugin-project",
        workspaceName: "plugin-workspace",
      });

      await service.start(
        createServiceContext(true, {
          enabled: false,
          apiKey: "runtime-key",
          apiUrl: "https://runtime-opik.example.com",
          projectName: "runtime-project",
          workspaceName: "runtime-workspace",
        }) as any,
      );

      expect(mockOpikConstructor).toHaveBeenCalledWith({
        apiKey: "plugin-key",
        apiUrl: "https://plugin-opik.example.com",
        projectName: "plugin-project",
        workspaceName: "plugin-workspace",
      });
    });

    test("falls back to env vars for client config", async () => {
      process.env.OPIK_API_KEY = "env-key";
      process.env.OPIK_URL_OVERRIDE = "https://env-opik.example.com";
      process.env.OPIK_PROJECT_NAME = "env-project";
      process.env.OPIK_WORKSPACE = "env-workspace";

      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext(true, { enabled: true }) as any);

      expect(mockOpikConstructor).toHaveBeenCalledWith({
        apiKey: "env-key",
        apiUrl: "https://env-opik.example.com",
        projectName: "env-project",
        workspaceName: "env-workspace",
      });
    });

    test("registers lifecycle/tool/subagent hooks + 1 diagnostic listener on start", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      expect(api.on).toHaveBeenCalledTimes(9);
      expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("subagent_spawning", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("subagent_delivery_target", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("subagent_spawned", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("subagent_ended", expect.any(Function));
      expect(api.on).not.toHaveBeenCalledWith("tool_result_persist", expect.any(Function));
      expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
      expect(diagnosticListeners).toHaveLength(1);
    });

    test("registers tool_result_persist hook only when enabled", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "test-key",
          toolResultPersistSanitizeEnabled: true,
        }) as any,
      );

      expect(api.on).toHaveBeenCalledWith("tool_result_persist", expect.any(Function));
    });
  });

  // =========================================================================
  // 2. llm_input hook
  // =========================================================================
  describe("llm_input hook", () => {
    test("only schedules attachments from the latest history message", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-4",
          provider: "openai",
          prompt: "clawcon",
          historyMessages: [
            { role: "user", content: "Main character energy 🦉✨ media:/tmp/old-image.png" },
            { role: "user", content: "clawcon" },
          ],
        },
        agentCtx("session-1"),
      );

      expect(mockScheduleMediaAttachmentUploads).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: ["clawcon", { role: "user", content: "clawcon" }],
        }),
      );
    });

    test("creates trace + LLM span with correct params", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-4",
          provider: "openai",
          prompt: "Hello",
          systemPrompt: "You are helpful",
          imagesCount: 0,
          sessionId: "sess-1",
          runId: "run-1",
          historyMessages: [],
        },
        agentCtx("session-1"),
      );

      expect(mockTraceFn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "gpt-4 \u00b7 telegram",
          threadId: "session-1",
          input: expect.objectContaining({ prompt: "Hello", systemPrompt: "You are helpful" }),
          metadata: expect.objectContaining({
            created_from: "openclaw",
            provider: "openai",
            model: "gpt-4",
            channel: "telegram",
          }),
          tags: ["openclaw"],
        }),
      );

      expect(mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "gpt-4",
          type: "llm",
          model: "gpt-4",
          provider: "openai",
        }),
      );
    });

    test("normalizes openai-codex provider to openai on trace/span creation", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-5.3-codex-spark",
          provider: "openai-codex",
          prompt: "Hello",
          historyMessages: [],
        },
        agentCtx("session-1"),
      );

      expect(mockTraceFn).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            provider: "openai",
          }),
        }),
      );
      expect(mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
        }),
      );
    });

    test("sanitizes media image references in llm_input payloads", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-4",
          provider: "openai",
          prompt: "send media:https://example.com/image.jpg",
          systemPrompt: "use media:./image.jpg for docs examples",
          imagesCount: 0,
          historyMessages: [
            {
              role: "user",
              content: "example media:/tmp/screenshot.png",
            },
          ],
        },
        agentCtx("session-1"),
      );

      const traceInput = mockTraceFn.mock.calls[0][0].input;
      expect(traceInput.prompt).toBe("send media:<image-ref>");
      expect(traceInput.systemPrompt).toBe("use media:<image-ref> for docs examples");

      const llmSpanInput = (mockTrace.span.mock.calls[0][0] as any).input;
      expect(llmSpanInput.historyMessages[0].content).toBe("example media:<image-ref>");
    });

    test("prefers channelId and records trigger metadata when provided", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "Hello" },
        agentCtx("session-1", { channelId: "discord", trigger: "cron" }),
      );

      expect(mockTraceFn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "gpt-4 \u00b7 discord",
          metadata: expect.objectContaining({
            channel: "discord",
            channelId: "discord",
            trigger: "cron",
          }),
        }),
      );
    });

    test("uses custom tags from config", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, { enabled: true, apiKey: "k", tags: ["custom", "prod"] }) as any,
      );

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-4",
          provider: "openai",
          prompt: "",
        },
        agentCtx("s1"),
      );

      expect(mockTraceFn).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ["custom", "prod"] }),
      );
    });

    test("sets tags=undefined when config tags is empty array", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, { enabled: true, apiKey: "k", tags: [] }) as any,
      );

      invokeHook(
        hooks,
        "llm_input",
        {
          model: "gpt-4",
          provider: "openai",
          prompt: "",
        },
        agentCtx("s1"),
      );

      expect(mockTraceFn).toHaveBeenCalledWith(expect.objectContaining({ tags: undefined }));
    });

    test("closes existing trace for same sessionKey before creating new one", async () => {
      const { api, hooks } = createApi();
      const firstTrace = opikState.createMockTrace();
      const secondTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValueOnce(firstTrace).mockReturnValueOnce(secondTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m1", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "llm_input", { model: "m2", provider: "p", prompt: "" }, agentCtx("s1"));

      expect(firstTrace.end).toHaveBeenCalled();
      expect(mockTraceFn).toHaveBeenCalledTimes(2);
    });

    test("no-ops when sessionKey is missing", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "" },
        agentCtx(undefined),
      );

      expect(mockTraceFn).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. llm_output hook
  // =========================================================================
  describe("llm_output hook", () => {
    test("updates LLM span with output, mapped usage, model, provider — then ends span", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1", { channelId: "discord", trigger: "cron" }),
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4",
          provider: "openai",
          assistantTexts: ["Hello!"],
          lastAssistant: "Hello!",
          usage: { input: 10, output: 20, total: 30, cacheRead: 5, cacheWrite: 3 },
        },
        agentCtx("s1"),
      );

      expect(mockLlmSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { assistantTexts: ["Hello!"], lastAssistant: "Hello!" },
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            cache_read_tokens: 5,
            cache_write_tokens: 3,
          },
          model: "gpt-4",
          provider: "openai",
        }),
      );
      expect(mockLlmSpan.end).toHaveBeenCalled();
    });

    test("normalizes openai-codex provider to openai on llm_output updates", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-5.3-codex-spark", provider: "openai-codex", prompt: "hi" },
        agentCtx("s1"),
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-5.3-codex-spark",
          provider: "openai-codex",
          assistantTexts: ["Hello!"],
          lastAssistant: "Hello!",
          usage: { input: 10, output: 20, total: 30 },
        },
        agentCtx("s1"),
      );

      expect(mockLlmSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
        }),
      );
    });

    test("does not call trace.update directly (deferred to finalization)", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1", { channelId: "discord", trigger: "cron" }),
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4",
          provider: "openai",
          assistantTexts: ["Hello!"],
          lastAssistant: "Hello!",
          usage: { input: 10, output: 20 },
        },
        agentCtx("s1"),
      );

      // llm_output should NOT call trace.update — output is deferred to finalizeTrace
      expect(mockTrace.update).not.toHaveBeenCalled();
    });

    test("omits usage when no fields provided", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "llm_output",
        {
          model: "m",
          provider: "p",
          assistantTexts: [],
          usage: {},
        },
        agentCtx("s1"),
      );

      expect(mockLlmSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({ usage: undefined }),
      );
    });

    test("maps usage fields correctly", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "llm_output",
        {
          model: "m",
          provider: "p",
          assistantTexts: [],
          usage: { input: 100, output: 50 },
        },
        agentCtx("s1"),
      );

      const usageArg = mockLlmSpan.update.mock.calls[0][0].usage;
      expect(usageArg).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
    });

    test("no-ops without prior llm_input / missing sessionKey", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      // No llm_input was called, so no active trace
      invokeHook(
        hooks,
        "llm_output",
        {
          model: "m",
          provider: "p",
          assistantTexts: [],
          usage: { input: 10 },
        },
        agentCtx("s1"),
      );

      // Should not throw, just no-op
      expect(mockTraceFn).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. before_tool_call hook
  // =========================================================================
  describe("before_tool_call hook", () => {
    test("creates tool span on active trace with correct params", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "before_tool_call",
        {
          toolName: "web_search",
          params: { query: "test" },
        },
        toolCtx("s1"),
      );

      expect(mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "web_search",
          type: "tool",
          input: { query: "test" },
        }),
      );
    });

    test("no-ops without active trace", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      // No llm_input — no active trace
      invokeHook(
        hooks,
        "before_tool_call",
        {
          toolName: "web_search",
          params: {},
        },
        toolCtx("s1"),
      );

      // No trace was created
      expect(mockTraceFn).not.toHaveBeenCalled();
    });

    test("adds run/tool correlation metadata when available", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      const mockToolSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "before_tool_call",
        {
          toolName: "web_search",
          params: { query: "test" },
          runId: "run-1",
          toolCallId: "call-1",
        },
        toolCtx("s1", { sessionId: "ephemeral-1", agentId: "agent-7" }),
      );

      expect(mockTrace.span).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          name: "web_search",
          type: "tool",
          input: { query: "test" },
          metadata: {
            agentId: "agent-7",
            sessionId: "ephemeral-1",
            runId: "run-1",
            toolCallId: "call-1",
          },
        }),
      );
    });
  });

  // =========================================================================
  // 5. after_tool_call hook
  // =========================================================================
  describe("after_tool_call hook", () => {
    test("finds matching tool span, updates with success result, ends span", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      // First span call is for LLM, second is for tool
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "before_tool_call", { toolName: "search", params: {} }, toolCtx("s1"));
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          result: { data: [1, 2, 3] },
        },
        toolCtx("s1"),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({ output: { data: [1, 2, 3] } });
      expect(mockToolSpan.end).toHaveBeenCalled();
    });

    test("sanitizes media image references in tool input and output payloads", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "before_tool_call",
        { toolName: "search", params: { path: "media:/tmp/image.png" } },
        toolCtx("s1"),
      );
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          params: { path: "media:https://example.com/image.jpg" },
          result: { imageRef: "media:./image.jpeg" },
        },
        toolCtx("s1"),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({
        input: { path: "media:<image-ref>" },
        output: { imageRef: "media:<image-ref>" },
      });
      expect(mockToolSpan.end).toHaveBeenCalled();
    });

    test("normalizes escaped newlines in tool output strings", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "before_tool_call", { toolName: "search", params: {} }, toolCtx("s1"));
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          result: "line 1\\nline 2",
        },
        toolCtx("s1"),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({
        output: { result: "line 1\nline 2" },
      });
      expect(mockToolSpan.end).toHaveBeenCalled();
    });

    test("uses after_tool_call params and duration metadata when provided", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "" },
        agentCtx("s1", { agentId: "agent-42" }),
      );
      invokeHook(
        hooks,
        "before_tool_call",
        { toolName: "search", params: { query: "old" } },
        toolCtx("s1", { agentId: "agent-42" }),
      );
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          params: { query: "new", limit: 3 },
          result: { ok: true },
          durationMs: 91,
        },
        toolCtx("s1", { agentId: "agent-42" }),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({
        input: { query: "new", limit: 3 },
        metadata: { durationMs: 91, agentId: "agent-42" },
        output: { ok: true },
      });
      expect(mockToolSpan.end).toHaveBeenCalled();
    });

    test("wraps non-object results in { result: value }", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "before_tool_call", { toolName: "calc", params: {} }, toolCtx("s1"));
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "calc",
          result: 42,
        },
        toolCtx("s1"),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({ output: { result: 42 } });
    });

    test("handles error with errorInfo", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "before_tool_call", { toolName: "api", params: {} }, toolCtx("s1"));
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "api",
          error: "Connection refused",
        },
        toolCtx("s1"),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({
        output: { error: "Connection refused" },
        errorInfo: {
          exceptionType: "ToolError",
          message: "Connection refused",
          traceback: "Connection refused",
        },
      });
      expect(mockToolSpan.end).toHaveBeenCalled();
    });

    test("no-ops when no matching tool span", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      // Call after_tool_call without a prior before_tool_call
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "unknown_tool",
          result: "data",
        },
        toolCtx("s1"),
      );

      // The LLM span is the only one created — no tool span update/end
      // trace.span called once for LLM span only (from llm_input)
      expect(mockTrace.span).toHaveBeenCalledTimes(1);
    });

    test("falls back when after_tool_call context is missing sessionKey", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      const ctx = createServiceContext() as any;
      await service.start(ctx);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "before_tool_call", { toolName: "search", params: {} }, toolCtx("s1"));

      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          result: { ok: true },
        },
        toolCtx(undefined),
      );

      expect(mockToolSpan.update).toHaveBeenCalledWith({ output: { ok: true } });
      expect(mockToolSpan.end).toHaveBeenCalledTimes(1);
      expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("after_tool_call missing sessionKey"),
      );
    });

    test("matches tool span by toolCallId when same tool name overlaps", async () => {
      const { api, hooks } = createApi();
      const mockToolSpanA = opikState.createMockSpan();
      const mockToolSpanB = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      mockTrace.span
        .mockReturnValueOnce(mockLlmSpan)
        .mockReturnValueOnce(mockToolSpanA)
        .mockReturnValueOnce(mockToolSpanB);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "before_tool_call",
        {
          toolName: "search",
          params: { query: "A" },
          runId: "run-1",
          toolCallId: "call-a",
        },
        toolCtx("s1", { sessionId: "sess-1", agentId: "agent-1" }),
      );
      invokeHook(
        hooks,
        "before_tool_call",
        {
          toolName: "search",
          params: { query: "B" },
          runId: "run-1",
          toolCallId: "call-b",
        },
        toolCtx("s1", { sessionId: "sess-1", agentId: "agent-1" }),
      );

      // End B first; without toolCallId matching this would incorrectly close A first.
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          result: { slot: "B" },
          runId: "run-1",
          toolCallId: "call-b",
        },
        toolCtx("s1", { sessionId: "sess-1", agentId: "agent-1" }),
      );
      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          result: { slot: "A" },
          runId: "run-1",
          toolCallId: "call-a",
        },
        toolCtx("s1", { sessionId: "sess-1", agentId: "agent-1" }),
      );

      expect(mockToolSpanB.update).toHaveBeenCalledWith({
        output: { slot: "B" },
        metadata: {
          agentId: "agent-1",
          sessionId: "sess-1",
          runId: "run-1",
          toolCallId: "call-b",
        },
      });
      expect(mockToolSpanA.update).toHaveBeenCalledWith({
        output: { slot: "A" },
        metadata: {
          agentId: "agent-1",
          sessionId: "sess-1",
          runId: "run-1",
          toolCallId: "call-a",
        },
      });
      expect(mockToolSpanA.end).toHaveBeenCalledTimes(1);
      expect(mockToolSpanB.end).toHaveBeenCalledTimes(1);
    });

    test("falls back via agentId when sessionKey is missing and multiple traces are active", async () => {
      const { api, hooks } = createApi();
      const traceA = opikState.createMockTrace();
      const traceB = opikState.createMockTrace();
      const llmSpanA = opikState.createMockSpan();
      const toolSpanA = opikState.createMockSpan();
      const llmSpanB = opikState.createMockSpan();
      const toolSpanB = opikState.createMockSpan();

      traceA.span.mockReturnValueOnce(llmSpanA).mockReturnValueOnce(toolSpanA);
      traceB.span.mockReturnValueOnce(llmSpanB).mockReturnValueOnce(toolSpanB);
      mockTraceFn.mockReturnValueOnce(traceA).mockReturnValueOnce(traceB);

      const service = createOpikService(api as any);
      const ctx = createServiceContext() as any;
      await service.start(ctx);

      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "" },
        agentCtx("s-a", { agentId: "agent-a" }),
      );
      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "" },
        agentCtx("s-b", { agentId: "agent-b" }),
      );
      invokeHook(
        hooks,
        "before_tool_call",
        { toolName: "search", params: { q: "first" } },
        toolCtx("s-a", { agentId: "agent-a" }),
      );
      invokeHook(
        hooks,
        "before_tool_call",
        { toolName: "search", params: { q: "second" } },
        toolCtx("s-b", { agentId: "agent-b" }),
      );

      invokeHook(
        hooks,
        "after_tool_call",
        {
          toolName: "search",
          params: { q: "second" },
          result: { ok: "b" },
        },
        toolCtx(undefined, { agentId: "agent-b" }),
      );

      expect(toolSpanA.update).not.toHaveBeenCalled();
      expect(toolSpanA.end).not.toHaveBeenCalled();
      expect(toolSpanB.update).toHaveBeenCalledWith({
        input: { q: "second" },
        metadata: { agentId: "agent-b" },
        output: { ok: "b" },
      });
      expect(toolSpanB.end).toHaveBeenCalledTimes(1);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("using agentId fallback"),
      );
    });
  });

  // =========================================================================
  // 6. subagent hooks
  // =========================================================================
  describe("subagent hooks", () => {
    test("records subagent lifecycle on the requester trace", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      const mockSubagentSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockSubagentSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "" },
        agentCtx("parent-session", { agentId: "parent-agent" }),
      );

      invokeHook(
        hooks,
        "subagent_spawning",
        {
          childSessionKey: "child-session",
          agentId: "writer",
          mode: "run",
          threadRequested: true,
        },
        { requesterSessionKey: "parent-session", childSessionKey: "child-session", runId: "run-sub-1" },
      );

      invokeHook(
        hooks,
        "subagent_spawned",
        {
          childSessionKey: "child-session",
          agentId: "writer",
          mode: "run",
          threadRequested: true,
          runId: "run-sub-1",
        },
        { requesterSessionKey: "parent-session", childSessionKey: "child-session", runId: "run-sub-1" },
      );

      invokeHook(
        hooks,
        "subagent_ended",
        {
          targetSessionKey: "child-session",
          targetKind: "subagent",
          reason: "completed",
          outcome: "ok",
        },
        { requesterSessionKey: "parent-session", childSessionKey: "child-session", runId: "run-sub-1" },
      );

      expect(mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "subagent:writer",
          input: expect.objectContaining({ childSessionKey: "child-session" }),
        }),
      );
      expect(mockSubagentSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            status: "spawned",
            childSessionKey: "child-session",
            runId: "run-sub-1",
          }),
        }),
      );
      expect(mockSubagentSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            status: "ended",
            targetSessionKey: "child-session",
            outcome: "ok",
          }),
        }),
      );
      expect(mockSubagentSpan.end).toHaveBeenCalledTimes(1);
    });

    test("records delivery-target metadata on active subagent span", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      const mockLlmSpan = opikState.createMockSpan();
      const mockSubagentSpan = opikState.createMockSpan();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockSubagentSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "" },
        agentCtx("parent-session", { agentId: "parent-agent" }),
      );

      invokeHook(
        hooks,
        "subagent_spawning",
        {
          childSessionKey: "child-session",
          agentId: "writer",
          mode: "run",
          threadRequested: true,
        },
        { requesterSessionKey: "parent-session", childSessionKey: "child-session", runId: "run-sub-1" },
      );

      invokeHook(
        hooks,
        "subagent_delivery_target",
        {
          childSessionKey: "child-session",
          requesterSessionKey: "parent-session",
          childRunId: "child-run-1",
          spawnMode: "run",
          expectsCompletionMessage: true,
          requesterOrigin: {
            channel: "discord",
            accountId: "account-1",
            to: "thread-42",
            threadId: 42,
          },
        },
        { requesterSessionKey: "parent-session", childSessionKey: "child-session", runId: "run-sub-1" },
      );

      expect(mockSubagentSpan.update).toHaveBeenCalledWith({
        metadata: {
          status: "delivery_target",
          requesterSessionKey: "parent-session",
          childSessionKey: "child-session",
          childRunId: "child-run-1",
          spawnMode: "run",
          expectsCompletionMessage: true,
          originChannel: "discord",
          originAccountId: "account-1",
          originTo: "thread-42",
          originThreadId: 42,
        },
      });
    });
  });

  // =========================================================================
  // 6b. tool_result_persist hook
  // =========================================================================
  describe("tool_result_persist hook", () => {
    test("sanitizes persisted tool messages with media image references", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "test-key",
          toolResultPersistSanitizeEnabled: true,
        }) as any,
      );

      const result = invokeHook(
        hooks,
        "tool_result_persist",
        {
          toolName: "read_file",
          message: {
            role: "tool",
            content: "preview media:/tmp/image.png",
          },
        },
        { sessionKey: "s1", agentId: "agent-1" },
      );

      expect(result).toEqual({
        message: {
          role: "tool",
          content: "preview media:<image-ref>",
        },
      });
    });

    test("returns undefined when no sanitization is needed", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "test-key",
          toolResultPersistSanitizeEnabled: true,
        }) as any,
      );

      const result = invokeHook(
        hooks,
        "tool_result_persist",
        {
          toolName: "read_file",
          message: {
            role: "tool",
            content: "plain text",
          },
        },
        { sessionKey: "s1", agentId: "agent-1" },
      );

      expect(result).toBeUndefined();
    });

    test("is not registered when tool_result_persist sanitization is disabled", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "test-key",
          toolResultPersistSanitizeEnabled: false,
        }) as any,
      );

      expect(hooks.tool_result_persist).toBeUndefined();
    });
  });

  // =========================================================================
  // 7. agent_end hook
  // =========================================================================
  describe("agent_end hook", () => {
    test("only schedules attachments from the trailing final message", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "m", provider: "p", prompt: "clawcon", historyMessages: [] },
        agentCtx("s1"),
      );
      invokeHook(
        hooks,
        "agent_end",
        {
          success: true,
          messages: [
            { role: "user", content: "Main character energy 🦉✨ media:/tmp/old-image.png" },
            { role: "assistant", content: "clawcon" },
          ],
        },
        agentCtx("s1"),
      );

      expect(mockScheduleMediaAttachmentUploads).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payloads: [undefined, { role: "assistant", content: "clawcon" }],
        }),
      );
    });

    test("closes orphaned spans, merges costMeta into metadata, ends trace, flushes", async () => {
      const { api, hooks } = createApi();
      const mockToolSpan = opikState.createMockSpan();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValueOnce(mockLlmSpan).mockReturnValueOnce(mockToolSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "before_tool_call", { toolName: "t1", params: {} }, toolCtx("s1"));

      // Simulate cost metadata from diagnostic event
      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "s1",
        costUsd: 0.05,
        context: { limit: 200000, used: 50000 },
      });

      invokeHook(
        hooks,
        "agent_end",
        {
          success: true,
          durationMs: 1234,
        },
        agentCtx("s1"),
      );

      // Orphaned tool span closed synchronously by agent_end
      expect(mockToolSpan.end).toHaveBeenCalled();

      // Trace finalization is deferred to microtask
      await Promise.resolve();

      // Trace should be updated with merged metadata
      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            costUsd: 0.05,
            contextLimit: 200000,
            contextUsed: 50000,
            success: true,
            durationMs: 1234,
          }),
        }),
      );

      expect(mockTrace.end).toHaveBeenCalled();
      await vi.waitFor(() => expect(mockFlush).toHaveBeenCalled());
    });

    test("includes errorInfo when event has error", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(
        hooks,
        "agent_end",
        {
          success: false,
          durationMs: 500,
          error: "Rate limit exceeded",
        },
        agentCtx("s1"),
      );

      await Promise.resolve();

      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ error: "Rate limit exceeded" }),
          errorInfo: {
            exceptionType: "AgentError",
            message: "Rate limit exceeded",
            traceback: "Rate limit exceeded",
          },
        }),
      );
    });

    test("no errorInfo when success", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "agent_end", { success: true, durationMs: 100 }, agentCtx("s1"));

      await Promise.resolve();

      const updateCall = mockTrace.update.mock.calls[0][0];
      expect(updateCall.errorInfo).toBeUndefined();
    });

    test("includes usage, model, provider from accumulated llm_output data", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1", { channelId: "discord", trigger: "cron" }),
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4",
          provider: "openai",
          assistantTexts: ["Hello!"],
          lastAssistant: "Hello!",
          usage: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
        },
        agentCtx("s1"),
      );

      invokeHook(hooks, "agent_end", { success: true, durationMs: 500 }, agentCtx("s1"));

      await Promise.resolve();

      // Single consolidated trace.update from finalizeTrace
      const agentEndCall = mockTrace.update.mock.calls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.metadata,
      );
      expect(agentEndCall).toBeDefined();
      const metadata = (agentEndCall![0] as Record<string, unknown>).metadata as Record<
        string,
        unknown
      >;

      expect(metadata.model).toBe("gpt-4");
      expect(metadata.provider).toBe("openai");
      expect(metadata.created_from).toBe("openclaw");
      expect(metadata.channel).toBe("discord");
      expect(metadata.channelId).toBe("discord");
      expect(metadata.trigger).toBe("cron");
      expect(metadata.usage).toEqual({
        input: 100,
        output: 50,
        total: 150,
        cacheRead: 10,
        cacheWrite: 5,
      });
    });

    test("normalizes openai-codex provider to openai in final trace metadata", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-5.3-codex-spark", provider: "openai-codex", prompt: "hi" },
        agentCtx("s1"),
      );
      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-5.3-codex-spark",
          provider: "openai-codex",
          assistantTexts: ["Hello!"],
          lastAssistant: "Hello!",
          usage: { input: 100, output: 50 },
        },
        agentCtx("s1"),
      );
      invokeHook(hooks, "agent_end", { success: true, durationMs: 500 }, agentCtx("s1"));

      await Promise.resolve();

      const metadata = mockTrace.update.mock.calls[0][0].metadata;
      expect(metadata.provider).toBe("openai");
    });

    test("preserves total-only usage in final trace metadata", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1"),
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4",
          provider: "openai",
          assistantTexts: ["Hello!"],
          usage: { total: 150 },
        },
        agentCtx("s1"),
      );

      invokeHook(hooks, "agent_end", { success: true, durationMs: 500 }, agentCtx("s1"));

      await Promise.resolve();

      const metadata = mockTrace.update.mock.calls[0][0].metadata as Record<string, unknown>;
      expect(metadata.usage).toEqual(expect.objectContaining({ total: 150 }));
    });

    test("no-ops without active trace", async () => {
      const { api, hooks } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      // No llm_input — no active trace
      invokeHook(hooks, "agent_end", { success: true, durationMs: 0 }, agentCtx("s1"));

      await Promise.resolve();

      expect(mockFlush).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6b. Deferred finalization (agent_end + llm_output ordering)
  // =========================================================================
  describe("deferred finalization", () => {
    test("full flow: llm_input → llm_output → agent_end → microtask produces consolidated trace.update", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1"),
      );

      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4",
          provider: "openai",
          assistantTexts: ["Hello!"],
          lastAssistant: "Hello!",
          usage: { input: 100, output: 50, total: 150 },
        },
        agentCtx("s1"),
      );

      invokeHook(hooks, "agent_end", { success: true, durationMs: 500 }, agentCtx("s1"));

      // Before microtask: trace.update/end not yet called
      expect(mockTrace.update).not.toHaveBeenCalled();
      expect(mockTrace.end).not.toHaveBeenCalled();

      await Promise.resolve();

      // After microtask: single consolidated trace.update with both output and metadata
      expect(mockTrace.update).toHaveBeenCalledTimes(1);
      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { output: "Hello!", lastAssistant: "Hello!" },
          metadata: expect.objectContaining({
            success: true,
            durationMs: 500,
            model: "gpt-4",
            provider: "openai",
            usage: { input: 100, output: 50, total: 150 },
          }),
        }),
      );
      expect(mockTrace.end).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(mockFlush).toHaveBeenCalledTimes(1));
    });

    test("agent_end without llm_output extracts output from messages", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1"),
      );

      // No llm_output — agent_end fires with messages
      invokeHook(
        hooks,
        "agent_end",
        {
          success: true,
          durationMs: 300,
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
          ],
        },
        agentCtx("s1"),
      );

      await Promise.resolve();

      // Output should be extracted from last assistant message
      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { output: "", lastAssistant: { role: "assistant", content: "Hi there!" } },
          metadata: expect.objectContaining({
            success: true,
            durationMs: 300,
          }),
        }),
      );

      // LLM span should be ended by finalizeTrace since llm_output never fired
      expect(mockLlmSpan.end).toHaveBeenCalled();
    });

    test("agent_end without llm_output falls back to diagnostic usage from costMeta", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1"),
      );

      // Diagnostic event provides usage via costMeta
      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "s1",
        costUsd: 0.02,
        usage: { input: 200, output: 100, cacheRead: 30, cacheWrite: 10, total: 340 },
      });

      // No llm_output — go straight to agent_end
      invokeHook(hooks, "agent_end", { success: true, durationMs: 400 }, agentCtx("s1"));

      await Promise.resolve();

      const metadata = mockTrace.update.mock.calls[0][0].metadata;
      // Usage should fall back to costMeta values since llm_output never fired
      expect(metadata.usage).toEqual({
        input: 200,
        output: 100,
        cacheRead: 30,
        cacheWrite: 10,
        total: 340,
      });
      expect(metadata.costUsd).toBe(0.02);
    });

    test("agent_end does not call trace.update or trace.end synchronously", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "agent_end", { success: true, durationMs: 100 }, agentCtx("s1"));

      // Synchronously: no trace.update or trace.end yet
      expect(mockTrace.update).not.toHaveBeenCalled();
      expect(mockTrace.end).not.toHaveBeenCalled();

      await Promise.resolve();

      // After microtask: finalization happened
      expect(mockTrace.update).toHaveBeenCalled();
      expect(mockTrace.end).toHaveBeenCalled();
    });

    test("empty assistantTexts with agent_end messages uses llm_output path (output: '')", async () => {
      const { api, hooks } = createApi();
      const mockLlmSpan = opikState.createMockSpan();
      const mockTrace = opikState.createMockTrace();
      mockTrace.span.mockReturnValue(mockLlmSpan);
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-4", provider: "openai", prompt: "hi" },
        agentCtx("s1"),
      );

      // llm_output fires with empty assistantTexts and undefined lastAssistant
      invokeHook(
        hooks,
        "llm_output",
        {
          model: "gpt-4",
          provider: "openai",
          assistantTexts: [],
          lastAssistant: undefined,
          usage: { input: 10, output: 5 },
        },
        agentCtx("s1"),
      );

      // agent_end fires with messages containing an assistant entry
      invokeHook(
        hooks,
        "agent_end",
        {
          success: true,
          durationMs: 200,
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "Hello there!" },
          ],
        },
        agentCtx("s1"),
      );

      await Promise.resolve();

      // llm_output path wins: output is "" (joined empty array), lastAssistant is undefined
      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { output: "", lastAssistant: undefined },
          metadata: expect.objectContaining({
            success: true,
            durationMs: 200,
          }),
        }),
      );
    });
  });

  // =========================================================================
  // 7. model.usage diagnostic event
  // =========================================================================
  describe("model.usage diagnostic event", () => {
    test("accumulates costUsd, contextLimit, contextUsed on active trace", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "s1",
        costUsd: 0.01,
        context: { limit: 128000, used: 10000 },
      });

      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "s1",
        costUsd: 0.03,
        context: { used: 20000 },
      });

      // Now end the agent to inspect the merged metadata
      invokeHook(hooks, "agent_end", { success: true, durationMs: 10 }, agentCtx("s1"));

      await Promise.resolve();

      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            costUsd: 0.03,
            contextLimit: 128000,
            contextUsed: 20000,
          }),
        }),
      );
    });

    test("captures model, provider, usage, durationMs from diagnostic events", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "s1",
        costUsd: 0.02,
        model: "claude-3-opus",
        provider: "anthropic",
        durationMs: 1500,
        usage: { input: 200, output: 100, cacheRead: 30, cacheWrite: 10, total: 340 },
        context: { limit: 200000, used: 60000 },
      });

      invokeHook(hooks, "agent_end", { success: true, durationMs: 2000 }, agentCtx("s1"));

      await Promise.resolve();

      const agentEndCall = mockTrace.update.mock.calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.metadata &&
          ((c[0] as Record<string, unknown>).metadata as Record<string, unknown>)?.success !==
            undefined,
      );
      expect(agentEndCall).toBeDefined();
      const metadata = (agentEndCall![0] as Record<string, unknown>).metadata as Record<
        string,
        unknown
      >;

      expect(metadata.costUsd).toBe(0.02);
      expect(metadata.contextLimit).toBe(200000);
      expect(metadata.contextUsed).toBe(60000);
      expect(metadata.usageInput).toBe(200);
      expect(metadata.usageOutput).toBe(100);
      expect(metadata.usageCacheRead).toBe(30);
      expect(metadata.usageCacheWrite).toBe(10);
      expect(metadata.usageTotal).toBe(340);
      // durationMs from diagnostic stored in costMeta, but overridden by agent_end durationMs
      expect(metadata.durationMs).toBe(2000);
    });

    test("normalizes diagnostic provider openai-codex to openai", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(
        hooks,
        "llm_input",
        { model: "gpt-5.3-codex-spark", provider: "openai-codex", prompt: "hi" },
        agentCtx("s1"),
      );

      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "s1",
        provider: "openai-codex",
      });

      invokeHook(hooks, "agent_end", { success: true, durationMs: 10 }, agentCtx("s1"));
      await Promise.resolve();

      const metadata = mockTrace.update.mock.calls[0][0].metadata;
      expect(metadata.provider).toBe("openai");
    });

    test("ignores non-model.usage events", async () => {
      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      diagnosticListeners[0]?.({
        type: "webhook.received",
        sessionKey: "s1",
        channel: "telegram",
      });

      invokeHook(hooks, "agent_end", { success: true, durationMs: 10 }, agentCtx("s1"));

      await Promise.resolve();

      // costMeta should be empty (no model.usage was dispatched)
      const metadata = mockTrace.update.mock.calls[0][0].metadata;
      expect(metadata.costUsd).toBeUndefined();
      expect(metadata.contextLimit).toBeUndefined();
    });

    test("ignores events for unknown sessionKey", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      // Dispatch for a sessionKey that has no active trace — should not throw
      diagnosticListeners[0]?.({
        type: "model.usage",
        sessionKey: "unknown-session",
        costUsd: 1.0,
      });
    });
  });

  // =========================================================================
  // 8. Stale trace cleanup
  // =========================================================================
  describe("stale trace cleanup", () => {
    test("closes traces inactive > 5 min with StaleTrace error", async () => {
      vi.useFakeTimers();

      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      // Advance time past stale threshold (5 min + sweep interval)
      vi.advanceTimersByTime(5 * 60 * 1000 + 60 * 1000);

      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { staleCleanup: true },
          errorInfo: expect.objectContaining({
            exceptionType: "StaleTrace",
            message: expect.stringContaining("inactivity threshold"),
          }),
        }),
      );
      expect(mockTrace.end).toHaveBeenCalled();

      await service.stop?.({} as any);
    });

    test("does NOT close recently active traces", async () => {
      vi.useFakeTimers();

      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      // Advance 2 minutes — well within the 5 min threshold
      vi.advanceTimersByTime(2 * 60 * 1000);

      // Activity via llm_output resets the timer
      invokeHook(
        hooks,
        "llm_output",
        {
          model: "m",
          provider: "p",
          assistantTexts: [],
          usage: {},
        },
        agentCtx("s1"),
      );

      // Advance another 2 minutes — sweep runs but trace still active
      vi.advanceTimersByTime(2 * 60 * 1000);

      // Trace should NOT have staleCleanup update
      const staleCalls = mockTrace.update.mock.calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.metadata &&
          ((c[0] as Record<string, unknown>).metadata as Record<string, unknown>)?.staleCleanup,
      );
      expect(staleCalls).toHaveLength(0);

      await service.stop?.({} as any);
    });

    test("flushes after all stale traces cleaned", async () => {
      vi.useFakeTimers();

      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      // Advance past stale threshold
      vi.advanceTimersByTime(5 * 60 * 1000 + 60 * 1000);

      // After cleanup, flush should be called since activeTraces is now empty
      await vi.waitFor(() => expect(mockFlush).toHaveBeenCalled());

      await service.stop?.({} as any);
    });

    test("can disable stale cleanup via config", async () => {
      vi.useFakeTimers();

      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "test-key",
          staleTraceCleanupEnabled: false,
        }) as any,
      );

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      vi.advanceTimersByTime(15 * 60 * 1000);

      const staleCalls = mockTrace.update.mock.calls.filter(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.metadata &&
          ((c[0] as Record<string, unknown>).metadata as Record<string, unknown>)?.staleCleanup,
      );
      expect(staleCalls).toHaveLength(0);

      await service.stop?.({} as any);
    });

    test("uses configured stale timeout and sweep interval", async () => {
      vi.useFakeTimers();

      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      await service.start(
        createServiceContext(true, {
          enabled: true,
          apiKey: "test-key",
          staleTraceTimeoutMs: 2_000,
          staleSweepIntervalMs: 1_000,
        }) as any,
      );

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));

      vi.advanceTimersByTime(3_100);

      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { staleCleanup: true },
          errorInfo: expect.objectContaining({ exceptionType: "StaleTrace" }),
        }),
      );

      await service.stop?.({} as any);
    });
  });

  // =========================================================================
  // 9. stop() cleanup
  // =========================================================================
  describe("stop() cleanup", () => {
    test("ends all active traces before flushing", async () => {
      const { api, hooks } = createApi();
      const mockTrace1 = opikState.createMockTrace();
      const mockTrace2 = opikState.createMockTrace();
      mockTraceFn.mockReturnValueOnce(mockTrace1).mockReturnValueOnce(mockTrace2);

      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s2"));

      await service.stop?.({} as any);

      expect(mockTrace1.end).toHaveBeenCalled();
      expect(mockTrace2.end).toHaveBeenCalled();
      expect(mockFlush).toHaveBeenCalled();
    });

    test("unsubscribes diagnostic listener", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      expect(diagnosticListeners).toHaveLength(1);

      await service.stop?.({} as any);

      expect(diagnosticListeners).toHaveLength(0);
    });

    test("retries flush with backoff when finalize flush fails", async () => {
      vi.useFakeTimers();

      const { api, hooks } = createApi();
      const mockTrace = opikState.createMockTrace();
      mockTraceFn.mockReturnValue(mockTrace);

      const service = createOpikService(api as any);
      const ctx = createServiceContext(true, {
        enabled: true,
        apiKey: "test-key",
        flushRetryCount: 1,
        flushRetryBaseDelayMs: 10,
      }) as any;
      await service.start(ctx);

      mockFlush.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(undefined);

      invokeHook(hooks, "llm_input", { model: "m", provider: "p", prompt: "" }, agentCtx("s1"));
      invokeHook(hooks, "agent_end", { success: true, durationMs: 10 }, agentCtx("s1"));

      await Promise.resolve();
      await vi.waitFor(() => expect(mockFlush).toHaveBeenCalledTimes(1));

      vi.advanceTimersByTime(10);
      await Promise.resolve();
      await vi.waitFor(() => expect(mockFlush).toHaveBeenCalledTimes(2));
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("flush failed"));
    });

    test("does not throw when flush rejects", async () => {
      const { api } = createApi();
      const service = createOpikService(api as any);
      await service.start(createServiceContext() as any);

      mockFlush.mockRejectedValueOnce(new Error("network error"));

      await expect(service.stop?.({} as any)).resolves.toBeUndefined();
    });
  });
});
