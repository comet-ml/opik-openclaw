#!/usr/bin/env node
/**
 * Codex-runtime E2E probe (OPIK-6509).
 *
 * Validates that this plugin's Codex extension factory is correctly invoked by
 * OpenClaw's real harness runner. Runs OUTSIDE the gateway: spins up a second
 * instance of the plugin's service pointed at the same mock Opik server, then
 * drives a synthetic Codex `tool_result` notification through OpenClaw's real
 * `createCodexAppServerToolResultExtensionRunner`. If the wiring is correct,
 * the mock Opik journal will contain a span with metadata.source === "codex_app_server".
 *
 * Requires: openclaw installed globally (e2e.yml does this), plugin built into dist/.
 */

import { createCodexAppServerToolResultExtensionRunner } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createOpikService } from "../dist/src/service.js";

const opikApiUrl = process.env.PROBE_OPIK_API_URL ?? "http://127.0.0.1:18791";
const opikApiKey = process.env.PROBE_OPIK_API_KEY ?? "mock-key";
const projectName = process.env.PROBE_OPIK_PROJECT ?? "e2e-test";
const probeMarker = process.env.PROBE_TOOL_NAME ?? "codex-probe-shell";

const capturedFactories = [];
const hooks = {};

const api = {
  on(event, handler) {
    hooks[event] = handler;
  },
  registerService() {},
  registerCli() {},
  registerCodexAppServerExtensionFactory(factory) {
    capturedFactories.push(factory);
  },
  runtime: {
    config: {
      loadConfig: () => ({}),
      writeConfigFile: async () => undefined,
    },
  },
  pluginConfig: {
    enabled: true,
    apiKey: opikApiKey,
    apiUrl: opikApiUrl,
    projectName,
    workspaceName: "default",
  },
};

const service = createOpikService(api, {
  enabled: true,
  apiKey: opikApiKey,
  apiUrl: opikApiUrl,
  projectName,
  workspaceName: "default",
});

await service.start({
  config: {
    enabled: true,
    apiKey: opikApiKey,
    apiUrl: opikApiUrl,
    projectName,
    workspaceName: "default",
  },
  logger: {
    info: (message) => console.error(`[probe-info] ${message}`),
    warn: (message) => console.error(`[probe-warn] ${message}`),
  },
});

if (capturedFactories.length === 0) {
  console.error(
    "[probe] FAIL: plugin did not call registerCodexAppServerExtensionFactory — Codex hook is not wired",
  );
  process.exit(1);
}

const sessionKey = "probe-session-1";
const runId = "probe-run-1";

const llmInputHandler = hooks["llm_input"];
if (typeof llmInputHandler !== "function") {
  console.error("[probe] FAIL: plugin did not register an llm_input hook");
  process.exit(1);
}
llmInputHandler(
  {
    model: "probe-model",
    provider: "probe-provider",
    prompt: "probe",
    systemPrompt: "probe",
    imagesCount: 0,
    sessionId: "probe-session-id-1",
    runId,
    historyMessages: [],
  },
  {
    sessionKey,
    agentId: "probe-agent",
    messageProvider: "probe",
    sessionId: "probe-session-id-1",
    runId,
  },
);

const runner = createCodexAppServerToolResultExtensionRunner(
  {
    agentId: "probe-agent",
    sessionId: "probe-session-id-1",
    sessionKey,
    runId,
  },
  capturedFactories,
);

const toolResultEvent = {
  threadId: "probe-thread-1",
  turnId: "probe-turn-1",
  toolCallId: "probe-call-1",
  toolName: probeMarker,
  args: { cmd: "echo probe" },
  result: { stdout: "probe-stdout" },
};

await runner.applyToolResultExtensions(toolResultEvent);

const agentEndHandler = hooks["agent_end"];
if (typeof agentEndHandler === "function") {
  agentEndHandler(
    { success: true, durationMs: 1 },
    { sessionKey, agentId: "probe-agent", runId },
  );
}

await new Promise((resolve) => setTimeout(resolve, 200));
await service.stop?.({});

console.error(
  `[probe] OK: drove ${capturedFactories.length} factory(ies) through the harness runner; marker tool="${probeMarker}"`,
);
