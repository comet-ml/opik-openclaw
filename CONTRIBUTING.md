# Contributing to OpenClaw Opik Plugin

Thanks for contributing to `@opik/opik-openclaw`.

## Before opening an issue

1. Search existing issues first: <https://github.com/comet-ml/opik-openclaw/issues>
2. Use the matching template:
   - Bug report: [.github/ISSUE_TEMPLATE/bug_report.yml](.github/ISSUE_TEMPLATE/bug_report.yml)
   - Feature request: [.github/ISSUE_TEMPLATE/feature_request.yml](.github/ISSUE_TEMPLATE/feature_request.yml)
3. Include reproducible steps, OpenClaw version, and plugin version.

## Local setup

Prerequisites:

- Node.js `>=22.12.0`
- npm `>=11`

Clone and bootstrap:

```bash
git clone https://github.com/comet-ml/opik-openclaw.git
cd opik-openclaw
npm install
```

Optional runtime config:

```bash
cp .env.example .env
```

## Development workflow

1. Create a focused branch for your change.
2. Keep changes scoped and avoid unrelated formatting-only edits.
3. Run local checks before opening/updating a PR.

Recommended local checks:

```bash
npm run lint
npm run typecheck
npm run test
npm run smoke
```

## Pull requests

Open PRs here: <https://github.com/comet-ml/opik-openclaw/pulls>

Please:

1. Prefer opening a draft PR early for feedback.
2. Follow the PR template: [.github/pull_request_template.md](.github/pull_request_template.md)
3. Link related issues using `Fixes #<issue-number>` (or `Resolves #<issue-number>`) in the PR body.
4. Update tests/docs for behavior changes.
5. Call out compatibility changes clearly.

If you use GitHub CLI, common commands are:

```bash
gh pr create --draft
gh pr view --web
```

## Releases

- Publish source of truth is GitHub Release + `.github/workflows/release.yml`.
- Release tags must match `package.json` version exactly as `v<version>`.

## Commit and review expectations

- Keep commits scoped and reviewable.
- Use clear commit messages that describe behavior changes.
- If changing user-facing configuration or CLI behavior, update `README.md`.

## Security and secrets

- Do not commit API keys, tokens, or `.env` files.
- Use `.env.example` as the template for new configuration fields.

## References

- OpenClaw community plugin docs: <https://docs.openclaw.ai/plugins/community>
- Opik docs: <https://www.comet.com/docs/opik>
