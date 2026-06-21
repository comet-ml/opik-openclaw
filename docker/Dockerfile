# Isolated OpenClaw runtime for manual E2E testing of opik-openclaw PR/branch builds.
# The plugin source is mounted and built at runtime, not baked in, so one image
# serves every branch. The container is run hardened and read-only (see test-local.sh).
# Digest-pinned for reproducibility (node:22-bookworm-slim as of 2026-06-17).
# Refresh with: docker pull node:22-bookworm-slim && docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim
FROM node:22-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

# git lets the agent exercise apply_patch/shell tool calls against a real working tree.
# The base image already ships current Debian security patches; the real risk
# mitigation for this disposable container is the runtime hardening in test-local.sh
# (unprivileged, cap-drop ALL, read-only rootfs, no-new-privileges, pid/memory caps).
# Reproducibility comes from the digest-pinned base above; apt versions are left
# unpinned because Debian stable drops superseded versions from its mirrors, which
# would break the build on the next security update.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw version to test against. Defaults to latest so the tool tracks current
# releases; pin via --build-arg OPENCLAW_VERSION=<version> for a reproducible run.
ARG OPENCLAW_VERSION=latest
ENV OPENCLAW_VERSION=${OPENCLAW_VERSION}

# Keep the npm/npx cache outside paths that are masked by tmpfs at runtime, so the
# warmed OpenClaw download survives into the read-only container.
ENV npm_config_cache=/opt/npm-cache
RUN mkdir -p /opt/npm-cache \
    && npx -y openclaw@"${OPENCLAW_VERSION}" --version \
    && chmod -R a+rX /opt/npm-cache

# Run as an unprivileged user; the base image ships a `node` user (uid 1000).
# /work and /home/node are provided as writable tmpfs mounts at runtime.
USER node
WORKDIR /work
ENV HOME=/home/node

COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
