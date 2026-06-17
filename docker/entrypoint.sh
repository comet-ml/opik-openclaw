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

: "${OPIK_API_KEY:?OPIK_API_KEY is required}"
: "${OPIK_URL_OVERRIDE:?OPIK_URL_OVERRIDE is required (e.g. https://www.comet.com/opik/api)}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required for the live model call}"
OPIK_PROJECT_NAME="${OPIK_PROJECT_NAME:-openclaw}"
OPIK_WORKSPACE="${OPIK_WORKSPACE:-default}"
LIVE_MODEL="${OPENCLAW_LIVE_MODEL:-gpt-4o-mini}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-local-e2e-token}"

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

# Mirror the config shape used by .scripts/live-e2e.mjs so the plugin loads with
# conversation hooks enabled and traces are routed to the engineer's project.
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
      "model": { "primary": "openai/${LIVE_MODEL}" }
    }
  },
  "plugins": {
    "allow": ["opik-openclaw"],
    "entries": {
      "opik-openclaw": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "enabled": true,
          "apiUrl": "${OPIK_URL_OVERRIDE}",
          "apiKey": "${OPIK_API_KEY}",
          "projectName": "${OPIK_PROJECT_NAME}",
          "workspaceName": "${OPIK_WORKSPACE}",
          "tags": ["local-docker-e2e"]
        }
      }
    }
  }
}
JSON

export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"

info "installing plugin build into OpenClaw..."
${OPENCLAW} plugins install "${TARBALL_PATH}"

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
for _ in $(seq 1 30); do
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

  Project:   ${OPIK_PROJECT_NAME}
  Workspace: ${OPIK_WORKSPACE}
  Endpoint:  ${OPIK_URL_OVERRIDE}

Run a turn that triggers tool calls, e.g.:

  openclaw agent --agent main --message "Use the shell tool to run 'echo hello', then reply done."

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
