#!/usr/bin/env bash
# Runs inside the container. Builds the plugin from the read-only source snapshot
# mounted at /src (so PR install scripts never run on the host), installs it into a
# fresh OpenClaw home, renders config from OPIK_* env, starts the gateway, then hands
# the engineer an interactive shell to run turns and observe spans in Opik.
set -euo pipefail

OPENCLAW="npx -y openclaw@${OPENCLAW_VERSION}"
SRC_DIR="/src"
BUILD_DIR="/work/plugin"
CONFIG_DIR="${HOME}/.openclaw"
CONFIG_PATH="${CONFIG_DIR}/openclaw.json"
GATEWAY_LOG="/tmp/gateway.log"

err() { printf '\033[31m[test-local] %s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m[test-local] %s\033[0m\n' "$*"; }

if [[ ! -d "${SRC_DIR}" || ! -f "${SRC_DIR}/package.json" ]]; then
  err "source snapshot not found at ${SRC_DIR} (expected it to be mounted)"
  exit 1
fi

: "${OPIK_URL_OVERRIDE:?OPIK_URL_OVERRIDE is required (e.g. https://www.comet.com/opik/api)}"
# Optional: unauthenticated local Opik deployments do not need a key.
OPIK_API_KEY="${OPIK_API_KEY:-}"
OPIK_PROJECT_NAME="${OPIK_PROJECT_NAME:-openclaw}"
OPIK_WORKSPACE="${OPIK_WORKSPACE:-default}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-local-e2e-token}"

# Model provider. Default is a local Ollama sidecar (no account, no real key).
# Set MODEL_PROVIDER=openai (and OPENAI_API_KEY) to drive turns with a real
# provider instead — e.g. to exercise the Codex runtime or a stronger model.
MODEL_PROVIDER="${MODEL_PROVIDER:-ollama}"
if [[ "${MODEL_PROVIDER}" == "ollama" ]]; then
  OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
  OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
  # Declare the model's full context. OpenClaw blocks windows below 16000 AND sizes
  # its prompt budget from this number, so it must be large enough to hold the agent
  # system prompt — too small overflows regardless of model size.
  OLLAMA_CONTEXT_WINDOW="${OLLAMA_CONTEXT_WINDOW:-131072}"
  AGENT_MODEL="ollama/${OLLAMA_MODEL}"
elif [[ "${MODEL_PROVIDER}" == "openai" ]]; then
  : "${OPENAI_API_KEY:?OPENAI_API_KEY is required when MODEL_PROVIDER=openai}"
  LIVE_MODEL="${OPENCLAW_LIVE_MODEL:-gpt-4o-mini}"
  AGENT_MODEL="openai/${LIVE_MODEL}"
else
  err "unsupported MODEL_PROVIDER: ${MODEL_PROVIDER} (expected 'ollama' or 'openai')"
  exit 1
fi

# GATEWAY_PORT is interpolated unquoted into the config JSON below; a non-integer
# would produce invalid JSON and fail the gateway with an opaque error, so reject it now.
if ! [[ "${GATEWAY_PORT}" =~ ^[0-9]+$ ]]; then
  err "OPENCLAW_GATEWAY_PORT must be an integer, got: ${GATEWAY_PORT}"
  exit 1
fi

# npm needs a writable cache; the rootfs is read-only, so point it at tmpfs and
# seed it from the image's warmed cache (which holds the pinned OpenClaw download).
export npm_config_cache="${HOME}/.npm"
mkdir -p "${npm_config_cache}"
if [[ -d /opt/npm-cache ]]; then
  cp -a /opt/npm-cache/. "${npm_config_cache}/" 2>/dev/null || true
fi

# Copy the read-only snapshot into a writable tmpfs dir and build there. Install
# scripts run here, inside the locked-down container, never on the host.
info "copying source snapshot into writable build dir..."
mkdir -p "${BUILD_DIR}"
cp -a "${SRC_DIR}/." "${BUILD_DIR}/"
cd "${BUILD_DIR}"

info "installing dependencies (npm ci)..."
npm ci

info "packing plugin (npm pack)..."
TARBALL_NAME="$(npm pack --silent)"
TARBALL_PATH="${BUILD_DIR}/${TARBALL_NAME}"
[[ -f "${TARBALL_PATH}" ]] || { err "npm pack did not produce a tarball"; exit 1; }
info "packed: ${TARBALL_NAME}"

mkdir -p "${CONFIG_DIR}"
export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"

# Write only the gateway + model defaults first. The plugin entry must NOT exist
# yet: `openclaw plugins install` validates config and aborts if it references a
# not-yet-installed plugin, and it injects plugins.entries.opik-openclaw itself.
#
# For Ollama, declare an explicit provider (baseUrl points at the sidecar; explicit
# config disables auto-discovery, so a manual model entry is required). Use the
# native Ollama API URL — no /v1 suffix, which would break tool calling.
if [[ "${MODEL_PROVIDER}" == "ollama" ]]; then
  PROVIDERS_BLOCK=$(cat <<JSON
,
  "models": {
    "providers": {
      "ollama": {
        "apiKey": "ollama-local",
        "baseUrl": "${OLLAMA_BASE_URL}",
        "api": "ollama",
        "models": [
          {
            "id": "${OLLAMA_MODEL}",
            "name": "${OLLAMA_MODEL}",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": ${OLLAMA_CONTEXT_WINDOW},
            "maxTokens": 2048
          }
        ]
      }
    }
  }
JSON
)
else
  PROVIDERS_BLOCK=""
fi

cat > "${CONFIG_PATH}" <<JSON
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": { "mode": "token", "token": "${GATEWAY_TOKEN}" },
    "port": ${GATEWAY_PORT}
  },
  "agents": {
    "defaults": {
      "model": { "primary": "${AGENT_MODEL}" }
    }
  }${PROVIDERS_BLOCK}
}
JSON

info "installing plugin build into OpenClaw..."
${OPENCLAW} plugins install "${TARBALL_PATH}"

# Merge Opik settings into the install-updated config via config set, one field at a
# time. Setting each scalar with its own dot-path passes the value as a raw string, so
# quotes/backslashes in OPIK_* env vars are stored verbatim — a hand-built JSON5 blob
# would break parsing or corrupt the value. install expands many defaults we preserve.
# No "hooks" key: openclaw 2026.3.2 rejects it as unrecognized; the plugin registers
# its own conversation hooks on load. tags is a fixed literal (no user input).
info "configuring Opik export..."
PLUGIN_CFG="plugins.entries.opik-openclaw.config"
${OPENCLAW} config set "${PLUGIN_CFG}.enabled" true
${OPENCLAW} config set "${PLUGIN_CFG}.apiUrl" "${OPIK_URL_OVERRIDE}"
if [[ -n "${OPIK_API_KEY}" ]]; then
  ${OPENCLAW} config set "${PLUGIN_CFG}.apiKey" "${OPIK_API_KEY}"
fi
${OPENCLAW} config set "${PLUGIN_CFG}.projectName" "${OPIK_PROJECT_NAME}"
${OPENCLAW} config set "${PLUGIN_CFG}.workspaceName" "${OPIK_WORKSPACE}"
${OPENCLAW} config set "${PLUGIN_CFG}.tags" '["local-docker-e2e"]'
${OPENCLAW} config set plugins.allow '["opik-openclaw"]'

if ! ${OPENCLAW} config validate; then
  err "config invalid after applying Opik settings"
  exit 1
fi

info "starting gateway on port ${GATEWAY_PORT}..."
${OPENCLAW} gateway run >"${GATEWAY_LOG}" 2>&1 &
GATEWAY_PID=$!

cleanup() {
  ${OPENCLAW} gateway stop >/dev/null 2>&1 || true
  if kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    kill "${GATEWAY_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 40); do
  if ${OPENCLAW} health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ -z "${ready}" ]]; then
  err "gateway failed to become ready; recent log:"
  tail -n 40 "${GATEWAY_LOG}" >&2 || true
  exit 1
fi

cat <<GUIDE

$(info "gateway ready — plugin installed and tracing to Opik")

  Provider:  ${MODEL_PROVIDER}
  Model:     ${AGENT_MODEL}
  Project:   ${OPIK_PROJECT_NAME}
  Workspace: ${OPIK_WORKSPACE}
  Endpoint:  ${OPIK_URL_OVERRIDE}

Run a turn that triggers tool calls. List configured agents first, then target one:

  openclaw agents list
  openclaw agent --agent <id> --message "Use the shell tool to run 'echo hello', then reply done."

(Or 'openclaw agent --local --message ...' to run the embedded agent without routing.)

Then open your Opik project and confirm:
  - an LLM span and a tool span (e.g. shell / apply_patch) under the trace
  - trace metadata.created_from = "openclaw"
  - for Codex-native runs (PR #114): span metadata.source = "codex_app_server"

Gateway log: ${GATEWAY_LOG}
Type 'exit' to tear everything down (container is --rm, nothing persists).

GUIDE

# Interactive shell for the engineer; if none is attached (non-tty run), keep the
# gateway alive in the foreground so the container is still usable.
if [[ $# -gt 0 ]]; then
  exec "$@"
elif [[ -t 0 ]]; then
  exec bash
else
  wait "${GATEWAY_PID}"
fi
