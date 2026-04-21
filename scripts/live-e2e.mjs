#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Opik } from "opik";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REQUIRED_ENV = ["OPENAI_API_KEY", "OPIK_API_KEY", "OPIK_URL_OVERRIDE"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());

if (missingEnv.length > 0) {
  console.error(
    `[live-e2e] missing required env: ${missingEnv.join(", ")}\n` +
      "Set the live OpenAI + Opik credentials, then rerun `npm run test:live`.",
  );
  process.exit(1);
}

const runId = `live-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const artifactDir = path.join(ROOT_DIR, ".artifacts", "live-e2e", runId);
const homeDir = path.join(artifactDir, "home");
const openclawDir = path.join(homeDir, ".openclaw");
const configPath = path.join(openclawDir, "openclaw.json");
const gatewayLogPath = path.join(artifactDir, "gateway.log");
const agentOutputPath = path.join(artifactDir, "agent-output.log");
const tracesPath = path.join(artifactDir, "opik-traces.json");
const spansPath = path.join(artifactDir, "opik-spans.json");

const gatewayPort = Number.parseInt(process.env.OPENCLAW_LIVE_GATEWAY_PORT ?? "18789", 10);
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || `live-${randomUUID()}`;
const opikProjectName = process.env.OPIK_PROJECT_NAME?.trim() || "openclaw";
const opikWorkspaceName = process.env.OPIK_WORKSPACE?.trim() || "default";
const liveModel = process.env.OPENCLAW_LIVE_MODEL?.trim() || "gpt-4o-mini";
const requestedOpenClawVersion = process.env.OPENCLAW_LIVE_OPENCLAW_VERSION?.trim() || "2026.4.15";
const promptToken = `token-${randomUUID().slice(0, 8)}`;
const agentMessage = `Reply with the single word pong. Preserve token ${promptToken}.`;
let opikSearchStartTime = new Date().toISOString();

const openclawInvocation = resolveOpenClawInvocation(requestedOpenClawVersion);
const openclawEnv = {
  ...process.env,
  HOME: homeDir,
  OPENCLAW_GATEWAY_TOKEN: gatewayToken,
};

await fs.mkdir(openclawDir, { recursive: true });
await fs.mkdir(artifactDir, { recursive: true });

const pluginTarballPath = await packPlugin();
await writeOpenClawConfig();

let gatewayProcess;

try {
  await runCommand(["plugins", "install", pluginTarballPath], {
    env: openclawEnv,
    name: "openclaw plugins install",
  });

  gatewayProcess = startDetachedProcess(["gateway", "run"], gatewayLogPath);
  await waitForGateway();

  opikSearchStartTime = new Date().toISOString();
  const agentRun = await runCommand(
    ["agent", "--agent", "main", "--message", agentMessage, "--deliver"],
    {
      env: openclawEnv,
      name: "openclaw agent",
      captureOutput: true,
    },
  );
  await fs.writeFile(agentOutputPath, agentRun.output, "utf8");

  if (agentRun.output.includes("falling back to embedded")) {
    throw new Error("gateway turn fell back to embedded mode");
  }
  if (!agentRun.output.toLowerCase().includes("pong")) {
    throw new Error("agent output did not contain the expected pong response");
  }

  const { traces, spans } = await verifyOpikExport();
  await fs.writeFile(tracesPath, JSON.stringify(traces, null, 2), "utf8");
  await fs.writeFile(spansPath, JSON.stringify(spans, null, 2), "utf8");

  console.log(
    `[live-e2e] PASS runId=${runId} traces=${traces.length} spans=${spans.length} artifacts=${artifactDir}`,
  );
} catch (error) {
  console.error(`[live-e2e] FAIL: ${formatError(error)}`);
  console.error(`[live-e2e] artifacts: ${artifactDir}`);
  process.exitCode = 1;
} finally {
  await stopGateway(gatewayProcess);
}

async function packPlugin() {
  const pack = await runCommand(["pack", "--pack-destination", artifactDir], {
    env: process.env,
    name: "npm pack",
    spawnCommand: "npm",
    captureOutput: true,
  });
  const tarball = pack.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`npm pack did not report a tarball path:\n${pack.output}`);
  }
  return path.join(artifactDir, tarball);
}

async function writeOpenClawConfig() {
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
    plugins: {
      allow: ["opik-openclaw"],
      entries: {
        "opik-openclaw": {
          enabled: true,
          config: {
            enabled: true,
            apiUrl: process.env.OPIK_URL_OVERRIDE,
            apiKey: process.env.OPIK_API_KEY,
            projectName: opikProjectName,
            workspaceName: opikWorkspaceName,
            tags: ["live-e2e"],
          },
        },
      },
    },
  };
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

async function verifyOpikExport() {
  const client = new Opik({
    apiKey: process.env.OPIK_API_KEY,
    apiUrl: process.env.OPIK_URL_OVERRIDE,
    projectName: opikProjectName,
    workspaceName: opikWorkspaceName,
  });

  const startedAtFilter = escapeOqlString(opikSearchStartTime);
  const traceFilter = `metadata.created_from = "openclaw" AND start_time >= "${startedAtFilter}"`;

  const traces = await client.searchTraces({
    projectName: opikProjectName,
    filterString: traceFilter,
    waitForAtLeast: 1,
    waitForTimeout: 90,
    maxResults: 20,
  });
  const matchingTrace = traces.find((trace) => serializedContains(trace.input, promptToken));
  if (!matchingTrace) {
    throw new Error(`no live Opik traces matched filter: ${traceFilter}`);
  }

  const spanFilter = `start_time >= "${startedAtFilter}"`;
  const spans = await client.searchSpans({
    projectName: opikProjectName,
    filterString: spanFilter,
    waitForAtLeast: 1,
    waitForTimeout: 90,
    maxResults: 30,
  });
  const matchingSpans = spans.filter(
    (span) =>
      (matchingTrace.id && span.traceId === matchingTrace.id) ||
      serializedContains(span.input, promptToken),
  );
  if (matchingSpans.length < 1) {
    throw new Error(`no live Opik spans matched filter: ${spanFilter}`);
  }

  return { traces: [matchingTrace], spans: matchingSpans };
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
