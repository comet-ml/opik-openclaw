#!/usr/bin/env bash
# Build an opik-openclaw PR/branch plugin and run it inside an isolated, hardened,
# disposable Docker container against your own Opik project for manual end-to-end
# verification.
#
# Usage:
#   ./scripts/test-local.sh <PR# | branch | --current>
#
# Examples:
#   ./scripts/test-local.sh 114                 # check out PR #114 and test it
#   ./scripts/test-local.sh my-feature-branch   # test a branch
#   ./scripts/test-local.sh --current           # test the current working tree as-is
#
# Safety model:
#   - The host runs only git (checkout + `git archive`); it never runs npm, so PR
#     install scripts cannot execute on your machine. The source snapshot is built
#     and packed entirely inside the container.
#   - The container runs unprivileged with all Linux capabilities dropped, a
#     read-only root filesystem (writable tmpfs only), no-new-privileges, and pid /
#     memory caps. It is --rm, so nothing persists on exit.
#   - Opik credentials are read from the environment (or a gitignored .env) and
#     passed at runtime only; they are never baked into the image.
#
# Required env (set directly or via .env):
#   OPIK_API_KEY, OPIK_URL_OVERRIDE, OPENAI_API_KEY
# Optional env:
#   OPIK_PROJECT_NAME (default: openclaw), OPIK_WORKSPACE (default: default),
#   OPENCLAW_LIVE_MODEL (default: gpt-4o-mini), OPENCLAW_VERSION (default: latest)
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

TARGET="${1:-}"
if [[ -z "${TARGET}" || "${TARGET}" == "-h" || "${TARGET}" == "--help" ]]; then
  usage
  [[ -z "${TARGET}" ]] && exit 1 || exit 0
fi

# Load .env if present so credentials can live in a gitignored file.
if [[ -f "${REPO_ROOT}/.env" ]]; then
  info "loading credentials from .env"
  set -a
  # shellcheck disable=SC1091
  . "${REPO_ROOT}/.env"
  set +a
fi

for var in OPIK_API_KEY OPIK_URL_OVERRIDE OPENAI_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    err "missing required env var: ${var}"
    err "set it in your shell or in ${REPO_ROOT}/.env (see .env.example)"
    exit 1
  fi
done

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
trap 'rm -rf "${SRC_DIR}"' EXIT
info "exporting source snapshot via git archive..."
git archive --format=tar "${REF}" | tar -x -C "${SRC_DIR}"

# --- Build the runtime image (toolchain only; no plugin source baked in) --------
info "building Docker image ${IMAGE_TAG}..."
docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  -t "${IMAGE_TAG}" \
  -f docker/Dockerfile \
  .

# --- Run the hardened, disposable container -------------------------------------
# Security flags:
#   --rm                       container and its writable layer are deleted on exit
#   --cap-drop ALL             drop all Linux capabilities
#   --security-opt no-new-privileges  block setuid privilege escalation
#   --read-only                root filesystem is immutable...
#   --tmpfs ...                ...with writable tmpfs only where the build/runtime needs it
#   --pids-limit / --memory    cap blast radius of a runaway or hostile build
#   source mounted :ro         the snapshot the container builds from cannot be mutated
info "starting isolated container (--rm, cap-drop, read-only rootfs; nothing persists)..."
docker run --rm -it \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /work:exec,size=1g,uid=1000,gid=1000 \
  --tmpfs /home/node:exec,size=1g,uid=1000,gid=1000 \
  --tmpfs /tmp:size=256m,uid=1000,gid=1000 \
  --pids-limit 512 \
  --memory 4g \
  -v "${SRC_DIR}:/src:ro" \
  -e "OPIK_API_KEY=${OPIK_API_KEY}" \
  -e "OPIK_URL_OVERRIDE=${OPIK_URL_OVERRIDE}" \
  -e "OPIK_PROJECT_NAME=${OPIK_PROJECT_NAME:-openclaw}" \
  -e "OPIK_WORKSPACE=${OPIK_WORKSPACE:-default}" \
  -e "OPENAI_API_KEY=${OPENAI_API_KEY}" \
  -e "OPENCLAW_LIVE_MODEL=${OPENCLAW_LIVE_MODEL:-gpt-4o-mini}" \
  "${IMAGE_TAG}"
