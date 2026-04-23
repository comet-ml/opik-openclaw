#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Opik } from "opik";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostHomeDir = process.env.HOME ?? "";
const hostOpenClawConfigPath = path.join(hostHomeDir, ".openclaw", "openclaw.json");
const useHostOpikConfig = process.env.OPENCLAW_LIVE_USE_HOST_OPIK_CONFIG !== "0";
const hostOpenClawConfig = useHostOpikConfig ? await readJsonIfExists(hostOpenClawConfigPath) : null;
const hostOpikPluginConfig = hostOpenClawConfig?.plugins?.entries?.["opik-openclaw"]?.config ?? null;

const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
const opikApiKeyResolution = resolveConfigValue({
  envKey: "OPIK_API_KEY",
  envValue: process.env.OPIK_API_KEY,
  fallbackValue: trimOrUndefined(hostOpikPluginConfig?.apiKey),
  fallbackSource: hostOpenClawConfigPath,
});
const opikApiUrlResolution = resolveConfigValue({
  envKey: "OPIK_URL_OVERRIDE",
  envValue: process.env.OPIK_URL_OVERRIDE,
  fallbackValue: trimOrUndefined(hostOpikPluginConfig?.apiUrl),
  fallbackSource: hostOpenClawConfigPath,
});
const opikProjectResolution = resolveConfigValue({
  envKey: "OPIK_PROJECT_NAME",
  envValue: process.env.OPIK_PROJECT_NAME,
  fallbackValue: trimOrUndefined(hostOpikPluginConfig?.projectName),
  fallbackSource: hostOpenClawConfigPath,
});
const opikWorkspaceResolution = resolveConfigValue({
  envKey: "OPIK_WORKSPACE",
  envValue: process.env.OPIK_WORKSPACE,
  fallbackValue: trimOrUndefined(hostOpikPluginConfig?.workspaceName),
  fallbackSource: hostOpenClawConfigPath,
});

const opikApiKey = opikApiKeyResolution.value;
const opikApiUrl = opikApiUrlResolution.value;
const opikProjectName = opikProjectResolution.value ?? "openclaw";
const opikWorkspaceName = opikWorkspaceResolution.value ?? "default";

const missingRequirements = [];
if (!openAiApiKey) {
  missingRequirements.push("OPENAI_API_KEY");
}
if (!opikApiKey) {
  missingRequirements.push(
    useHostOpikConfig
      ? "OPIK_API_KEY or ~/.openclaw/openclaw.json plugins.entries.opik-openclaw.config.apiKey"
      : "OPIK_API_KEY",
  );
}
if (!opikApiUrl) {
  missingRequirements.push(
    useHostOpikConfig
      ? "OPIK_URL_OVERRIDE or ~/.openclaw/openclaw.json plugins.entries.opik-openclaw.config.apiUrl"
      : "OPIK_URL_OVERRIDE",
  );
}
if (missingRequirements.length > 0) {
  console.error(
    `[live-e2e] missing required live config:\n- ${missingRequirements.join("\n- ")}\n` +
      "Set env vars or configure the installed opik-openclaw plugin in ~/.openclaw/openclaw.json.",
  );
  process.exit(1);
}

const scenarioDefinitions = [
  {
    id: "basic-response",
    minSpanCount: 1,
    buildPrompt: (token) => `Reply with the single word pong. Preserve token ${token}.`,
    assertAgentOutput(output) {
      if (!output.toLowerCase().includes("pong")) {
        throw new Error("agent output did not contain the expected pong response");
      }
    },
    assertExport({ traces, spans }) {
      if (traces.length !== 1) {
        throw new Error(`expected exactly 1 matching trace, got ${traces.length}`);
      }
      if (spans.length < 1) {
        throw new Error(`expected at least 1 matching span, got ${spans.length}`);
      }
    },
  },
  {
    id: "tool-exec",
    minSpanCount: 2,
    buildPrompt: (token) =>
      `Use the exec tool exactly once to run the shell command printf '${token}'. ` +
      `After reading the command output, reply with only ${token}. Do not guess and do not skip the tool.`,
    assertAgentOutput(output, token) {
      if (!output.includes(token)) {
        throw new Error("agent output did not contain the expected tool token");
      }
    },
    assertExport({ traces, spans }) {
      if (traces.length !== 1) {
        throw new Error(`expected exactly 1 matching trace, got ${traces.length}`);
      }
      const [trace] = traces;
      if (trace.hasToolSpans !== true) {
        throw new Error("matching trace did not report tool spans");
      }
      if ((trace.spanCount ?? 0) < 2) {
        throw new Error(`expected at least 2 spans on the matching trace, got ${trace.spanCount}`);
      }

      const llmSpans = spans.filter((span) => span.type === "llm");
      const toolSpans = spans.filter((span) => span.type === "tool");
      if (llmSpans.length < 1) {
        throw new Error("no llm spans were returned for the tool scenario");
      }
      if (toolSpans.length < 1) {
        throw new Error("no tool spans were returned for the tool scenario");
      }

      const llmSpanIds = new Set(llmSpans.map((span) => span.id).filter(Boolean));
      const hasNestedToolSpan = toolSpans.some(
        (span) => typeof span.parentSpanId === "string" && llmSpanIds.has(span.parentSpanId),
      );
      if (!hasNestedToolSpan) {
        throw new Error("no tool span was parented to a matching llm span");
      }
    },
  },
];

const requestedScenarioIds = parseScenarioIds(process.env.OPENCLAW_LIVE_SCENARIOS);
const scenarios =
  requestedScenarioIds.length > 0
    ? scenarioDefinitions.filter((scenario) => requestedScenarioIds.includes(scenario.id))
    : scenarioDefinitions;

if (scenarios.length === 0) {
  throw new Error(
    requestedScenarioIds.length > 0
      ? `OPENCLAW_LIVE_SCENARIOS did not match any known scenarios: ${requestedScenarioIds.join(", ")}`
      : "no live scenarios were selected",
  );
}

const runId = `live-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const artifactDir = path.join(ROOT_DIR, ".artifacts", "live-e2e", runId);
const homeDir = path.join(artifactDir, "home");
const openclawDir = path.join(homeDir, ".openclaw");
const configPath = path.join(openclawDir, "openclaw.json");
const gatewayLogPath = path.join(artifactDir, "gateway.log");
const resultsPath = path.join(artifactDir, "results.json");

const gatewayPort = Number.parseInt(process.env.OPENCLAW_LIVE_GATEWAY_PORT ?? "18789", 10);
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || `live-${randomUUID()}`;
const liveModel = process.env.OPENCLAW_LIVE_MODEL?.trim() || "gpt-4o-mini";
const requestedOpenClawVersion = process.env.OPENCLAW_LIVE_OPENCLAW_VERSION?.trim() || "latest";

const openclawInvocation = resolveOpenClawInvocation(requestedOpenClawVersion);
const openclawEnv = {
  ...process.env,
  HOME: homeDir,
  OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  OPENAI_API_KEY: openAiApiKey,
};

await fs.mkdir(openclawDir, { recursive: true });
await fs.mkdir(artifactDir, { recursive: true });

const pluginTarballPath = await packPlugin();
await writeOpenClawConfig({ enablePlugin: false });

let gatewayProcess;

try {
  console.log(
    `[live-e2e] config sources: opikApiKey=${opikApiKeyResolution.source}, ` +
      `opikApiUrl=${opikApiUrlResolution.source}, project=${opikProjectResolution.source}, ` +
      `workspace=${opikWorkspaceResolution.source}`,
  );
  console.log(
    `[live-e2e] scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")} ` +
      `openclaw=${openclawInvocation.command}${openclawInvocation.baseArgs.length > 0 ? ` ${openclawInvocation.baseArgs.join(" ")}` : ""}`,
  );

  await runCommand(["plugins", "install", pluginTarballPath], {
    env: openclawEnv,
    name: "openclaw plugins install",
  });
  await writeOpenClawConfig({ enablePlugin: true });

  gatewayProcess = startDetachedProcess(["gateway", "run"], gatewayLogPath);
  await waitForGateway();

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");

  console.log(
    `[live-e2e] PASS runId=${runId} scenarios=${results.length} artifacts=${artifactDir}`,
  );
} catch (error) {
  console.error(`[live-e2e] FAIL: ${formatError(error)}`);
  console.error(`[live-e2e] artifacts: ${artifactDir}`);
  process.exitCode = 1;
} finally {
  await stopGateway(gatewayProcess);
}

async function runScenario(scenario) {
  const scenarioDir = path.join(artifactDir, scenario.id);
  const agentOutputPath = path.join(scenarioDir, "agent-output.log");
  const tracesPath = path.join(scenarioDir, "opik-traces.json");
  const spansPath = path.join(scenarioDir, "opik-spans.json");
  const tokenPrefix = scenario.id === "tool-exec" ? "tool-token" : "token";
  const promptToken = `${tokenPrefix}-${randomUUID().slice(0, 8)}`;
  const agentMessage = scenario.buildPrompt(promptToken);

  await fs.mkdir(scenarioDir, { recursive: true });

  console.log(`[live-e2e] scenario start: ${scenario.id}`);
  const opikSearchStartTime = new Date().toISOString();
  const agentRun = await runCommand(["agent", "--agent", "main", "--message", agentMessage], {
    env: openclawEnv,
    name: `openclaw agent (${scenario.id})`,
    captureOutput: true,
  });
  await fs.writeFile(agentOutputPath, agentRun.output, "utf8");

  if (agentRun.output.includes("falling back to embedded")) {
    throw new Error(`gateway turn fell back to embedded mode during ${scenario.id}`);
  }
  scenario.assertAgentOutput(agentRun.output, promptToken);

  const { traces, spans } = await verifyOpikExport({
    promptToken,
    startedAt: opikSearchStartTime,
    minSpanCount: scenario.minSpanCount,
  });

  await fs.writeFile(tracesPath, JSON.stringify(traces, null, 2), "utf8");
  await fs.writeFile(spansPath, JSON.stringify(spans, null, 2), "utf8");

  scenario.assertExport({ traces, spans, promptToken });

  const traceSummary = traces.map((trace) => ({
    id: trace.id,
    spanCount: trace.spanCount,
    llmSpanCount: trace.llmSpanCount,
    hasToolSpans: trace.hasToolSpans,
  }));
  const spanSummary = spans.map((span) => ({
    id: span.id,
    parentSpanId: span.parentSpanId,
    name: span.name,
    type: span.type,
    traceId: span.traceId,
  }));

  console.log(
    `[live-e2e] scenario pass: ${scenario.id} traces=${traces.length} spans=${spans.length}`,
  );

  return {
    scenario: scenario.id,
    promptToken,
    traces: traceSummary,
    spans: spanSummary,
  };
}

async function packPlugin() {
  const pack = await runCommand(["pack", "--json", "--pack-destination", artifactDir], {
    env: process.env,
    name: "npm pack",
    spawnCommand: "npm",
    captureOutput: true,
  });
  const tarball = JSON.parse(pack.output)?.[0]?.filename;
  if (typeof tarball !== "string" || !tarball.endsWith(".tgz")) {
    throw new Error(`npm pack did not report a tarball path:\n${pack.output}`);
  }
  return path.join(artifactDir, tarball);
}

async function writeOpenClawConfig(params) {
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      port: gatewayPort,
    },
    agents: {
      defaults: {
        model: {
          primary: `openai/${liveModel}`,
        },
      },
    },
  };
  if (params.enablePlugin) {
    config.plugins = {
      allow: ["opik-openclaw"],
      entries: {
        "opik-openclaw": {
          enabled: true,
          config: {
            enabled: true,
            apiUrl: opikApiUrl,
            apiKey: opikApiKey,
            projectName: opikProjectName,
            workspaceName: opikWorkspaceName,
            tags: ["live-e2e"],
          },
        },
      },
    };
  }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function resolveOpenClawInvocation(version) {
  const explicitBin = process.env.OPENCLAW_LIVE_BIN?.trim();
  if (explicitBin) {
    return { command: explicitBin, baseArgs: [] };
  }
  const direct = spawnSync("openclaw", ["--version"], { stdio: "ignore" });
  if (direct.status === 0) {
    return { command: "openclaw", baseArgs: [] };
  }
  return { command: "npx", baseArgs: ["-y", `openclaw@${version}`] };
}

function startDetachedProcess(args, logPath) {
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(openclawInvocation.command, [...openclawInvocation.baseArgs, ...args], {
    cwd: ROOT_DIR,
    env: openclawEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.on("close", () => {
    logStream.end();
  });
  return child;
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await runCommand(["health"], {
      env: openclawEnv,
      name: "openclaw health",
      allowFailure: true,
      captureOutput: true,
    });
    if (health.code === 0) {
      return;
    }
    await sleep(1000);
  }
  throw new Error(`gateway failed to become ready; see ${gatewayLogPath}`);
}

async function stopGateway(gateway) {
  await runCommand(["gateway", "stop"], {
    env: openclawEnv,
    name: "openclaw gateway stop",
    allowFailure: true,
  });

  if (!gateway) {
    return;
  }

  if (gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => gateway.once("close", resolve)),
      sleep(5000),
    ]);
  }
  if (gateway.exitCode === null) {
    gateway.kill("SIGKILL");
  }
}

async function verifyOpikExport(params) {
  const client = new Opik({
    apiKey: opikApiKey,
    apiUrl: opikApiUrl,
    projectName: opikProjectName,
    workspaceName: opikWorkspaceName,
  });

  const startedAtFilter = escapeOqlString(params.startedAt);
  const traceFilter = `metadata.created_from = "openclaw" AND start_time >= "${startedAtFilter}"`;

  const traces = await client.searchTraces({
    projectName: opikProjectName,
    filterString: traceFilter,
    waitForAtLeast: 1,
    waitForTimeout: 90,
    maxResults: 20,
  });
  const matchingTraces = traces.filter(
    (trace) =>
      serializedContains(trace.input, params.promptToken) ||
      serializedContains(trace.output, params.promptToken),
  );
  if (matchingTraces.length < 1) {
    throw new Error(`no live Opik traces matched filter: ${traceFilter}`);
  }

  const spanFilter = `start_time >= "${startedAtFilter}"`;
  const spans = await client.searchSpans({
    projectName: opikProjectName,
    filterString: spanFilter,
    waitForAtLeast: params.minSpanCount,
    waitForTimeout: 90,
    maxResults: 50,
  });
  const traceIds = new Set(matchingTraces.map((trace) => trace.id).filter(Boolean));
  const matchingSpans = spans.filter(
    (span) =>
      traceIds.has(span.traceId) ||
      serializedContains(span.input, params.promptToken) ||
      serializedContains(span.output, params.promptToken),
  );
  if (matchingSpans.length < params.minSpanCount) {
    throw new Error(
      `expected at least ${params.minSpanCount} live Opik spans, got ${matchingSpans.length}`,
    );
  }

  return { traces: matchingTraces, spans: matchingSpans };
}

function escapeOqlString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function serializedContains(value, token) {
  if (value === undefined || value === null) {
    return false;
  }
  return JSON.stringify(value).includes(token);
}

function resolveConfigValue(params) {
  const envValue = trimOrUndefined(params.envValue);
  if (envValue) {
    return { value: envValue, source: `env:${params.envKey}` };
  }
  if (params.fallbackValue) {
    return { value: params.fallbackValue, source: params.fallbackSource };
  }
  return { value: undefined, source: "unset" };
}

function parseScenarioIds(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return [];
  }
  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function readJsonIfExists(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function trimOrUndefined(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function runCommand(args, options) {
  const command = options.spawnCommand ?? openclawInvocation.command;
  const fullArgs =
    options.spawnCommand === undefined
      ? [...openclawInvocation.baseArgs, ...args]
      : args;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, {
      cwd: ROOT_DIR,
      env: options.env,
      stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let output = "";
    if (options.captureOutput) {
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${options.name} failed with exit code ${code}\n${
              options.captureOutput ? output : ""
            }`,
          ),
        );
        return;
      }
      resolve({ code: code ?? 0, output });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
