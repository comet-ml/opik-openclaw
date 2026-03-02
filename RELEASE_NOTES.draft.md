# Draft Release Notes - `@comet-ml/openclaw-opik`

## Version Bump Plan

- Current package version: `2026.2.16`
- Proposed release version: `2026.3.2` (not applied yet)
- Release command (when approved): `npm publish --access public`

## Summary

- Migrated Opik integration to OpenClaw community plugin config model:
  `plugins.entries.opik.enabled` + `plugins.entries.opik.config.*`.
- Preserved tracing parity for LLM, tool, agent-end, and diagnostic usage metadata flows.
- Added fallback correlation path when `after_tool_call` omits `sessionKey` in embedded tool handlers.
- Added plugin manifest schema + UI hints for secure config rendering.
- Added standalone package/test/typecheck/smoke setup for community distribution.

## Validation

- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm run test` passed (`48` tests).
- `npm run smoke` passed (`2` tests).
- `npm pack --dry-run` validated publish payload.

## Notes

- Public publish/PR actions are intentionally deferred pending explicit approval.
