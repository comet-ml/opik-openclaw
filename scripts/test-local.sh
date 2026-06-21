#!/usr/bin/env bash
# Build an opik-openclaw PR/branch plugin and run it inside an isolated, hardened,
# disposable Docker container against your own Opik project for manual end-to-end
# verification.
#
# Usage:
#   ./scripts/test-local.sh <PR# | branch | --current> [--provider ollama|openai]
#
# Examples:
#   ./scripts/test-local.sh 114                 # check out PR #114, test it with local Ollama (default)
#   ./scripts/test-local.sh my-feature-branch   # test a branch
#   ./scripts/test-local.sh --current           # test the current working tree as-is
#   ./scripts/test-local.sh 114 --provider openai   # drive turns with a real provider (OpenAI/Codex)
#
# Model provider:
#   - ollama (default): runs a local LLM in a sidecar container — no model-provider
#     account or API key. Good for verifying trace export + LLM/tool spans.
#   - openai: drives turns with a real provider via your OPENAI_API_KEY. Needed for
#     stronger tool-calling or the Codex runtime (codex_app_server spans). The key is
#     yours, injected at runtime only, never baked into the image.
#
# Safety model:
#   - The host runs only git (checkout + `git archive`); it never runs npm, so PR
#     install scripts cannot execute on your machine. The source snapshot is built
#     and packed entirely inside the container.
#   - The container runs unprivileged with all Linux capabilities dropped, a
#     read-only root filesystem (writable tmpfs only), no-new-privileges, and pid /
#     memory caps. It is --rm, so nothing persists on exit.
#   - Credentials are read from the environment (or a gitignored .env) and passed at
#     runtime only; they are never baked into the image.
#
# Required env (set directly or via .env):
#   OPIK_URL_OVERRIDE                        (always)
#   OPENAI_API_KEY                           (only when --provider openai)
# Optional env:
#   OPIK_API_KEY                             (omit for unauthenticated local Opik)
# Optional env:
#   OPIK_PROJECT_NAME (default: openclaw), OPIK_WORKSPACE (default: default),
#   OLLAMA_MODEL (default: llama3.2:3b), OPENCLAW_LIVE_MODEL (default: gpt-4o-mini),
#   OPENCLAW_VERSION (default: latest)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

IMAGE_TAG="opik-openclaw-e2e:local"
# Default to the latest published OpenClaw so the tool tracks current releases.
# Pin via OPENCLAW_VERSION=<version> for a reproducible run.
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"

err() { printf '\033[31m[test-local] %s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m[test-local] %s\033[0m\n' "$*"; }

usage() {
  # Print the leading comment block (skip the shebang, stop at the first non-comment line).
  awk 'NR==1 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "${BASH_SOURCE[0]}"
}

TARGET=""
PROVIDER="ollama"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --provider=*)
      PROVIDER="${1#*=}"
      shift
      ;;
    *)
      if [[ -z "${TARGET}" ]]; then
        TARGET="$1"
        shift
      else
        err "unexpected argument: $1"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "${TARGET}" ]]; then
  usage
  exit 1
fi

if [[ "${PROVIDER}" != "ollama" && "${PROVIDER}" != "openai" ]]; then
  err "unsupported --provider: ${PROVIDER} (expected 'ollama' or 'openai')"
  exit 1
fi

# Load .env if present so credentials can live in a gitignored file.
if [[ -f "${REPO_ROOT}/.env" ]]; then
  info "loading credentials from .env"
  set -a
  # shellcheck disable=SC1091
  . "${REPO_ROOT}/.env"
  set +a
fi

# OPIK_API_KEY is optional: unauthenticated local Opik deployments do not need one.
REQUIRED_ENV=(OPIK_URL_OVERRIDE)
[[ "${PROVIDER}" == "openai" ]] && REQUIRED_ENV+=(OPENAI_API_KEY)
for var in "${REQUIRED_ENV[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    err "missing required env var: ${var}"
    err "set it in your shell or in ${REPO_ROOT}/.env (see .env.example)"
    exit 1
  fi
done

# Default the optional key so it can be referenced safely under `set -u`.
OPIK_API_KEY="${OPIK_API_KEY:-}"

command -v docker >/dev/null 2>&1 || { err "docker is not installed or not on PATH"; exit 1; }

# --- Resolve the requested PR / branch to a git ref (no code execution) ---------
# Checkout uses git only; we never run npm on the host, so a malicious PR's install
# scripts cannot run here. The build happens inside the container from a git archive.
resolve_ref() {
  local target="$1"

  if [[ "${target}" == "--current" ]]; then
    info "testing current working tree (HEAD)"
    echo "HEAD"
    return
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    err "working tree has uncommitted changes; commit/stash them or use --current"
    exit 1
  fi

  if [[ "${target}" =~ ^[0-9]+$ ]]; then
    info "checking out PR #${target}"
    if command -v gh >/dev/null 2>&1; then
      gh pr checkout "${target}" >&2
    else
      info "gh not found; fetching pull/${target}/head via git"
      git fetch origin "pull/${target}/head:pr-${target}" >&2
      git checkout "pr-${target}" >&2
    fi
  else
    info "checking out branch ${target}"
    git fetch origin "${target}" >/dev/null 2>&1 || true
    git checkout "${target}" >&2
  fi
  echo "HEAD"
}

REF="$(resolve_ref "${TARGET}")"
info "testing ref: $(git rev-parse --short "${REF}") ($(git rev-parse --abbrev-ref HEAD))"

# --- Snapshot the source with git archive (pure git, runs no project code) ------
SRC_DIR="$(mktemp -d)"
trap 'rm -rf "${SRC_DIR}"' EXIT  # replaced by a provider-specific trap before the container runs
info "exporting source snapshot via git archive..."
git archive --format=tar "${REF}" | tar -x -C "${SRC_DIR}"

# --- Build the runtime image (toolchain only; no plugin source baked in) --------
info "building Docker image ${IMAGE_TAG}..."
docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  -t "${IMAGE_TAG}" \
  -f docker/Dockerfile \
  .

# Run artifacts (span results etc.) land here so they survive container teardown.
OUT_DIR="$(mktemp -d)"
info "run artifacts: ${OUT_DIR}"

# The hardening below is identical across providers: unprivileged, cap-drop ALL,
# no-new-privileges, read-only rootfs with writable tmpfs only, pid/memory caps, and
# the source mounted :ro. Nothing persists on exit.
if [[ "${PROVIDER}" == "ollama" ]]; then
  # Local LLM sidecar via compose — no model-provider account or key. The model is
  # pulled into a named volume (once) and the gateway reaches it over a private network.
  OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
  COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.ollama.yml"
  export SRC_DIR OUT_DIR OLLAMA_MODEL OPIK_API_KEY OPIK_URL_OVERRIDE
  export OPIK_PROJECT_NAME="${OPIK_PROJECT_NAME:-openclaw}"
  export OPIK_WORKSPACE="${OPIK_WORKSPACE:-default}"

  compose() { docker compose -f "${COMPOSE_FILE}" -p opik-openclaw-e2e "$@"; }
  cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "${SRC_DIR}" "${OUT_DIR}"; }
  trap cleanup EXIT

  info "starting Ollama sidecar and pulling model ${OLLAMA_MODEL} (first run downloads it)..."
  compose up -d ollama
  compose exec -T ollama ollama pull "${OLLAMA_MODEL}"

  info "starting isolated tester container (provider=ollama; nothing persists)..."
  compose run --rm tester
else
  # Real provider (OpenAI/Codex): the user's key is injected at runtime only.
  info "starting isolated container (provider=openai, --rm, cap-drop, read-only rootfs)..."
  trap 'rm -rf "${SRC_DIR}" "${OUT_DIR}"' EXIT
  docker run --rm -it \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /work:exec,size=2g,uid=1000,gid=1000 \
    --tmpfs /home/node:exec,size=3g,uid=1000,gid=1000 \
    --tmpfs /tmp:size=512m,uid=1000,gid=1000 \
    --pids-limit 512 \
    --memory 4g \
    -v "${SRC_DIR}:/src:ro" \
    -v "${OUT_DIR}:/out" \
    -e "MODEL_PROVIDER=openai" \
    -e "OPIK_API_KEY=${OPIK_API_KEY}" \
    -e "OPIK_URL_OVERRIDE=${OPIK_URL_OVERRIDE}" \
    -e "OPIK_PROJECT_NAME=${OPIK_PROJECT_NAME:-openclaw}" \
    -e "OPIK_WORKSPACE=${OPIK_WORKSPACE:-default}" \
    -e "OPENAI_API_KEY=${OPENAI_API_KEY}" \
    -e "OPENCLAW_LIVE_MODEL=${OPENCLAW_LIVE_MODEL:-gpt-4o-mini}" \
    "${IMAGE_TAG}"
fi
