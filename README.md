<h1 align="center" style="border-bottom: none">
  <div>
    <a href="https://www.comet.com/site/products/opik/">
      <img alt="Comet Opik logo" src="https://raw.githubusercontent.com/comet-ml/opik-mcp/refs/heads/main/docs/assets/logo-light-mode.svg" width="200" />
    </a>
    <br />
    OpenClaw Opik Plugin
  </div>
</h1>

<p align="center">
Community plugin for <a href="https://github.com/openclaw/openclaw">OpenClaw</a> that exports agent traces to <a href="https://www.comet.com/docs/opik/">Opik</a>.
</p>

<div align="center">

[![License](https://img.shields.io/github/license/comet-ml/opik-openclaw)](https://github.com/comet-ml/opik-openclaw/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@comet-ml/openclaw-opik)](https://www.npmjs.com/package/@comet-ml/openclaw-opik)

</div>

## Why this plugin

`@comet-ml/openclaw-opik` adds native Opik tracing for OpenClaw workflows:

- LLM request/response spans
- Tool call spans and outputs
- Agent lifecycle finalization
- Token usage and cost metadata

The plugin runs inside the OpenClaw Gateway process. If Gateway is remote, install/configure the plugin on that host.

## Quickstart

### 1. Configure from OpenClaw CLI

```bash
openclaw opik configure
```

This validates endpoint and credentials and writes plugin-scoped config under `plugins.entries.opik`.

### 2. Check effective configuration

```bash
openclaw opik status
```

### 3. Verify trace export

```bash
openclaw gateway run
openclaw message send "hello from openclaw"
```

Then confirm traces in your Opik project.

## Configuration

### Plugin-scoped config (recommended)

```json
{
  "plugins": {
    "entries": {
      "opik": {
        "enabled": true,
        "config": {
          "enabled": true,
          "apiKey": "your-api-key",
          "apiUrl": "https://www.comet.com/opik/api",
          "projectName": "openclaw",
          "workspaceName": "default",
          "tags": ["openclaw"]
        }
      }
    }
  }
}
```

### Environment fallbacks

- `OPIK_API_KEY`
- `OPIK_URL_OVERRIDE`
- `OPIK_PROJECT_NAME`
- `OPIK_WORKSPACE`

## CLI commands

| Command | Description |
| --- | --- |
| `openclaw opik configure` | Interactive setup wizard |
| `openclaw opik status` | Print effective Opik configuration |

## Data mapping

| OpenClaw event | Opik entity | Notes |
| --- | --- | --- |
| `llm_input` | trace + llm span | Creates trace and starts model span |
| `llm_output` | llm span update/end | Updates usage/output and closes span |
| `before_tool_call` | tool span start | Captures tool name and input |
| `after_tool_call` | tool span update/end | Captures result/error and duration |
| `agent_end` | trace finalize | Consolidates deferred metadata |

## Known limitations

OpenClaw embedded tool handlers can emit `after_tool_call` without `sessionKey` in some paths. This plugin applies a deterministic fallback (active-session map/latest active trace), but concurrent multi-session tool traffic can still mis-correlate a span.

No OpenClaw core changes are included in this repository.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run smoke
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

Apache 2.0
