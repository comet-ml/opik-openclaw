import * as p from "@clack/prompts";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OpikPluginConfig } from "./types.js";

type ConfigDeps = {
  loadConfig: () => OpenClawConfig;
  writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
};

type RegisterOpikCliParams = {
  program: any;
} & ConfigDeps;

/** Opik Cloud host (matches SDK's DEFAULT_HOST_URL). */
const OPIK_CLOUD_HOST = "https://www.comet.com/";
const OPIK_CLOUD_SIGNUP_URL = "https://www.comet.com/signup?from=llm";
/** Default local Opik URL (matches SDK's DEFAULT_LOCAL_URL). */
const DEFAULT_LOCAL_URL = "http://localhost:5173/";
/** Max URL validation retries (matches SDK's MAX_URL_VALIDATION_RETRIES). */
const MAX_URL_RETRIES = 3;
const OPIK_PLUGIN_ID = "opik-openclaw";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function getOpikPluginEntry(cfg: OpenClawConfig): {
  enabled?: boolean;
  config: Record<string, unknown>;
} {
  const root = asObject(cfg);
  const plugins = asObject(root.plugins);
  const entries = asObject(plugins.entries);
  const entry = asObject(entries[OPIK_PLUGIN_ID]);
  const config = asObject(entry.config);
  return {
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
    config,
  };
}

export function setOpikPluginEntry(
  cfg: OpenClawConfig,
  config: OpikPluginConfig,
  enabled = true,
): OpenClawConfig {
  const root = asObject(cfg);
  const plugins = asObject(root.plugins);
  const entries = asObject(plugins.entries);
  const existingEntry = asObject(entries[OPIK_PLUGIN_ID]);
  const nextEntries = {
    ...entries,
    [OPIK_PLUGIN_ID]: {
      ...existingEntry,
      enabled,
      config: {
        ...asObject(existingEntry.config),
        ...config,
      },
    },
  };
  return {
    ...root,
    plugins: {
      ...plugins,
      entries: nextEntries,
    },
  } as OpenClawConfig;
}

// ---------------------------------------------------------------------------
// URL helpers (mirrors opik SDK api-helpers.ts / urls.ts)
// ---------------------------------------------------------------------------

/** Ensure trailing slash on a URL. */
function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Build the Opik API URL from a host.
 * Local hosts use `/api`, cloud/self-hosted use `/opik/api`.
 * Mirrors `buildOpikApiUrl` in the Opik SDK.
 */
function buildOpikApiUrl(host: string): string {
  const normalized = host.endsWith("/") ? host.slice(0, -1) : host;
  const isLocal = normalized.includes("localhost") || normalized.includes("127.0.0.1");
  return `${normalized}${isLocal ? "/api" : "/opik/api"}`;
}

/**
 * Build a browser URL pointing to the projects list in the Opik UI.
 * Cloud/self-hosted: {host}opik/{workspace}/projects
 * Local:             {host}{workspace}/projects
 */
function buildProjectsUrl(host: string, workspaceName: string): string {
  const base = host.endsWith("/") ? host.slice(0, -1) : host;
  const isLocal = base.includes("localhost") || base.includes("127.0.0.1");
  const prefix = isLocal ? "" : "/opik";
  return `${base}${prefix}/${encodeURIComponent(workspaceName)}/projects`;
}

function buildApiKeysUrl(host: string): string {
  return new URL("account-settings/apiKeys", normalizeUrl(host)).toString();
}

export function getApiKeyHelpText(
  deployment: "cloud" | "self-hosted",
  host: string,
): string[] {
  const lines = [`You can find your Opik API key here:\n${buildApiKeysUrl(host)}`];

  if (deployment === "cloud") {
    lines.push(`No Opik Cloud account yet? Sign up for a free account:\n${OPIK_CLOUD_SIGNUP_URL}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// API validation helpers (mirrors opik SDK api-helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Check if an Opik instance is accessible at the given URL.
 * Accepts 2xx-4xx as valid (even 404 means server is running).
 * Mirrors `isOpikAccessible` in the Opik SDK.
 */
async function isOpikAccessible(url: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const healthUrl = new URL("health", normalizeUrl(url)).toString();
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Fetch the default workspace for an API key.
 * Mirrors `getDefaultWorkspace` in the Opik SDK.
 * @returns The default workspace name on success, throws on failure.
 */
async function getDefaultWorkspace(apiKey: string, baseUrl: string): Promise<string> {
  const accountDetailsUrl = new URL("api/rest/v2/account-details", baseUrl).toString();
  const res = await fetch(accountDetailsUrl, {
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch account details (status ${res.status})`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.defaultWorkspaceName !== "string" || !body.defaultWorkspaceName) {
    throw new Error("defaultWorkspaceName not found in the response");
  }

  return body.defaultWorkspaceName;
}

// ---------------------------------------------------------------------------
// Deployment-specific URL handlers (mirrors opik SDK clack-utils.ts)
// ---------------------------------------------------------------------------

/**
 * Handle local deployment URL config with auto-detection and retry.
 * Mirrors `handleLocalDeploymentConfig` in the Opik SDK.
 */
async function handleLocalDeploymentConfig(): Promise<string> {
  const isDefaultRunning = await isOpikAccessible(DEFAULT_LOCAL_URL, 3_000);
  if (isDefaultRunning) {
    p.log.success(`Local Opik instance detected at ${DEFAULT_LOCAL_URL}`);
    return normalizeUrl(DEFAULT_LOCAL_URL);
  }

  p.log.warn(`Local Opik instance not found at ${DEFAULT_LOCAL_URL}`);
  return promptAndValidateUrl("http://localhost:5173/");
}

/**
 * Handle self-hosted deployment URL config with retry.
 * Mirrors `handleSelfHostedDeploymentConfig` in the Opik SDK.
 */
async function handleSelfHostedDeploymentConfig(): Promise<string> {
  return promptAndValidateUrl("https://your-opik-instance.com/");
}

/**
 * Prompt the user for a URL and validate connectivity, retrying up to MAX_URL_RETRIES times.
 * Returns the normalized URL on success, or calls p.cancel and throws on max retries.
 */
async function promptAndValidateUrl(placeholder: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_URL_RETRIES; attempt++) {
    const urlInput = await p.text({
      message: "Please enter your Opik instance URL:",
      placeholder,
      validate(value) {
        if (!value || !value.trim()) return "URL cannot be empty. Please enter a valid URL...";
        try {
          new URL(value.trim());
        } catch {
          return "Invalid URL format. The URL should follow a format similar to http://localhost:5173/";
        }
      },
    });

    if (p.isCancel(urlInput)) {
      p.cancel("Setup cancelled.");
      throw new Error("cancelled");
    }

    const normalized = normalizeUrl((urlInput as string).trim());
    const spinner = p.spinner();
    spinner.start("Checking connectivity...");
    const accessible = await isOpikAccessible(normalized, 5_000);
    spinner.stop(accessible ? "Connected." : "Not reachable.");

    if (accessible) return normalized;

    if (attempt + 1 < MAX_URL_RETRIES) {
      p.log.error(
        `Opik is not accessible at ${normalized}. Please try again. (Attempt ${attempt + 1}/${MAX_URL_RETRIES})`,
      );
    }
  }

  p.cancel(`Failed to connect to Opik after ${MAX_URL_RETRIES} attempts.`);
  throw new Error(`Failed to connect to Opik after ${MAX_URL_RETRIES} attempts`);
}

// ---------------------------------------------------------------------------
// Interactive configure wizard (mirrors opik SDK getOrAskForProjectData)
// ---------------------------------------------------------------------------

async function runOpikConfigure(deps: ConfigDeps): Promise<void> {
  p.intro("Opik setup");

  // Step 1: Check if local Opik is already running (for hint in selector)
  const isLocalRunning = await isOpikAccessible(DEFAULT_LOCAL_URL, 3_000);

  // Step 2: Deployment type selection
  const deployment = await p.select({
    message: "Which Opik deployment do you want to log your traces to?",
    options: [
      { value: "cloud" as const, label: "Opik Cloud", hint: "https://www.comet.com" },
      {
        value: "self-hosted" as const,
        label: "Self-hosted Comet platform",
        hint: "Custom Opik instance",
      },
      {
        value: "local" as const,
        label: isLocalRunning
          ? `Local deployment (detected at ${DEFAULT_LOCAL_URL})`
          : "Local deployment",
        hint: isLocalRunning ? "Running" : "http://localhost:5173",
      },
    ],
    initialValue: isLocalRunning ? ("local" as const) : ("cloud" as const),
  });

  if (p.isCancel(deployment)) {
    p.cancel("Setup cancelled.");
    return;
  }

  // Step 3: Resolve host URL based on deployment type
  let host: string;
  try {
    if (deployment === "local") {
      host = await handleLocalDeploymentConfig();
    } else if (deployment === "self-hosted") {
      host = await handleSelfHostedDeploymentConfig();
    } else {
      host = OPIK_CLOUD_HOST;
    }
  } catch {
    // User cancelled or max retries — already handled via p.cancel
    return;
  }

  // Step 4: API key + workspace (only for cloud and self-hosted)
  let apiKey: string | undefined;
  let workspaceName: string;

  if (deployment === "local") {
    workspaceName = "default";
  } else {
    // Loop until we get a valid API key (mirrors SDK behavior)
    let defaultWorkspaceName: string | undefined;
    let apiKeyValidated = false;

    while (!apiKeyValidated) {
      for (const line of getApiKeyHelpText(deployment, host)) {
        p.log.info(line);
      }

      const keyInput = await p.password({
        message: "Enter your Opik API key:",
        validate(value) {
          if (!value || !value.trim()) return "API key is required";
        },
      });

      if (p.isCancel(keyInput)) {
        p.cancel("Setup cancelled.");
        return;
      }

      apiKey = (keyInput as string).trim();

      // Validate by fetching default workspace
      const spinner = p.spinner();
      spinner.start("Validating API key...");
      try {
        defaultWorkspaceName = await getDefaultWorkspace(apiKey, host);
        apiKeyValidated = true;
        spinner.stop("API key validated.");
      } catch {
        spinner.stop("Invalid API key.");
        p.log.error("Invalid API key. Please check your API key and try again.");
      }
    }

    // Ask for workspace name with default from API
    const workspaceInput = await p.text({
      message: defaultWorkspaceName
        ? `Enter your workspace name (press Enter to use: ${defaultWorkspaceName}):`
        : "Enter your workspace name:",
      placeholder: defaultWorkspaceName ?? "your-workspace-name",
      initialValue: defaultWorkspaceName,
      validate(value) {
        if ((!value || !value.trim()) && !defaultWorkspaceName) {
          return "Workspace name is required";
        }
      },
    });

    if (p.isCancel(workspaceInput)) {
      p.cancel("Setup cancelled.");
      return;
    }

    workspaceName = ((workspaceInput as string) || defaultWorkspaceName || "default").trim();
  }

  // Step 5: Project name
  const projectInput = await p.text({
    message: "Enter your project name (optional):",
    placeholder: "openclaw",
    initialValue: "openclaw",
  });

  if (p.isCancel(projectInput)) {
    p.cancel("Setup cancelled.");
    return;
  }

  const projectName = (projectInput as string).trim() || "openclaw";

  // Step 6: Build API URL from host and write config
  const apiUrl = buildOpikApiUrl(host);
  const cfg = deps.loadConfig();
  const existingOpik = getOpikPluginEntry(cfg).config as OpikPluginConfig;

  const nextOpik: OpikPluginConfig = {
    ...existingOpik,
    enabled: true,
    apiUrl,
    ...(apiKey ? { apiKey } : {}),
    workspaceName,
    projectName,
  };

  const nextCfg = setOpikPluginEntry(cfg, nextOpik, true);

  await deps.writeConfigFile(nextCfg);

  const projectsUrl = buildProjectsUrl(host, workspaceName);

  p.note(
    [
      `API URL:    ${apiUrl}`,
      `Workspace:  ${workspaceName}`,
      `Project:    ${projectName}`,
      `API key:    ${apiKey ? "***" : "(none)"}`,
      "",
      `View your projects: ${projectsUrl}`,
    ].join("\n"),
    "Opik configuration saved",
  );
  p.outro("Restart the gateway to apply changes.");
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

export function showOpikStatus(deps: ConfigDeps): void {
  const cfg = deps.loadConfig();
  const entry = getOpikPluginEntry(cfg);
  const opik = entry.config;

  if (entry.enabled === undefined && Object.keys(opik).length === 0) {
    console.log("Opik is not configured. Run: openclaw opik configure");
    return;
  }

  const enabled = entry.enabled !== false && opik.enabled !== false;
  const lines = [
    `  Enabled:    ${enabled ? "yes" : "no"}`,
    `  API URL:    ${(opik.apiUrl as string) ?? "(default)"}`,
    `  Workspace:  ${(opik.workspaceName as string) ?? "default"}`,
    `  Project:    ${(opik.projectName as string) ?? "openclaw"}`,
    `  API key:    ${opik.apiKey ? "***" : "(not set)"}`,
  ];
  const tags = opik.tags as string[] | undefined;
  if (tags?.length) {
    lines.push(`  Tags:       ${tags.join(", ")}`);
  }

  console.log("Opik status:\n");
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerOpikCli(params: RegisterOpikCliParams): void {
  const { program, loadConfig, writeConfigFile } = params;
  const deps: ConfigDeps = { loadConfig, writeConfigFile };

  const root = program.command("opik").description("Opik trace export integration");

  root
    .command("configure")
    .description("Interactive setup for Opik trace export")
    .action(async () => {
      await runOpikConfigure(deps);
    });

  root
    .command("status")
    .description("Show current Opik configuration")
    .action(() => {
      showOpikStatus(deps);
    });
}
