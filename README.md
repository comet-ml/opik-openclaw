<h1 align="center" style="border-bottom: none">
  <div>
    <a href="https://www.comet.com/site/products/opik/?from=llm&utm_source=opik&utm_medium=github&utm_content=header_img&utm_campaign=opik">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/comet-ml/opik/refs/heads/main/apps/opik-documentation/documentation/static/img/logo-dark-mode.svg">
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/comet-ml/opik/refs/heads/main/apps/opik-documentation/documentation/static/img/opik-logo.svg">
        <img alt="Comet Opik logo" src="https://raw.githubusercontent.com/comet-ml/opik/refs/heads/main/apps/opik-documentation/documentation/static/img/opik-logo.svg" width="200" />
      </picture>
    </a>
    <br />
    🔭 OpenClaw Opik Observability Plugin
  </div>
</h1>

<p align="center">
  Official plugin for <a href="https://github.com/openclaw/openclaw">OpenClaw</a> that exports agent traces to <br/>
  <a href="https://www.comet.com/docs/opik/">Opik</a> for observability and monitoring.
</p>

<div align="center">

[![License](https://img.shields.io/github/license/comet-ml/opik-openclaw)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/%40opik%2Fopik-openclaw)](https://www.npmjs.com/package/@opik/opik-openclaw)

<img src="screenshot.png" alt="Openclaw on Opik Demo"/>

</div>

## Why This Plugin

[Opik](https://github.com/comet-ml/opik) is a leading open-source LLM and agent observability, tracing, evaluation and optimization platform.
`@opik/opik-openclaw` adds native Opik tracing for OpenClaw runs:

- LLM request/response spans
- Sub-agent request/response spans
- Tool call spans with inputs, outputs, and errors
- Run-level finalize metadata
- Usage and cost metadata

The plugin runs inside the OpenClaw Gateway process. If your gateway is remote, install and configure the plugin on that host.

## Install and first run

Prerequisites:

- OpenClaw `>=2026.3.2`
- Node.js `>=22.12.0`
- npm `>=10`

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install @opik/opik-openclaw
```

If the Gateway is already running, restart it after install.

### 2. Configure the plugin

```bash
openclaw opik configure
```

The setup wizard validates endpoint and credentials, then writes config under `plugins.entries.opik-openclaw`. If you choose Opik Cloud and do not have an account yet, the wizard now points you to the free signup flow before asking for an API key.

### 3. Check effective settings

```bash
openclaw opik status
```

### 4. Send a test message

```bash
openclaw gateway run
openclaw message send "hello from openclaw"
```

Then confirm traces in your Opik project.

## Configuration

### Recommended config shape

```json
{
  "plugins": {
    "entries": {
      "opik-openclaw": {
        "enabled": true,
        "config": {
          // base configuration
          "enabled": true,
          "apiKey": "your-api-key",
          "apiUrl": "https://www.comet.com/opik/api",
          "projectName": "openclaw",
          "workspaceName": "default",
          // optional advanced configuration
          "tags": ["openclaw"],
          "toolResultPersistSanitizeEnabled": false,
          "staleTraceCleanupEnabled": true,
          "staleTraceTimeoutMs": 300000,
          "staleSweepIntervalMs": 60000,
          "flushRetryCount": 2,
          "flushRetryBaseDelayMs": 250
        }
      }
    }
  }
}
```

### Plugin trust allowlist

OpenClaw warns when `plugins.allow` is empty and a community plugin is discovered. Pin trusted plugins explicitly:

```json
{
  "plugins": {
    "allow": ["opik-openclaw"]
  }
}
```

### Environment fallbacks

- `OPIK_API_KEY`
- `OPIK_URL_OVERRIDE`
- `OPIK_PROJECT_NAME`
- `OPIK_WORKSPACE`

### Transcript safety default

`toolResultPersistSanitizeEnabled` is disabled by default. When enabled, the plugin rewrites local
image refs in persisted tool transcript messages via `tool_result_persist`.

## CLI commands

| Command | Description |
| --- | --- |
| `openclaw plugins install @opik/opik-openclaw` | Install plugin package |
| `openclaw opik configure` | Interactive setup wizard |
| `openclaw opik status` | Print effective Opik configuration |

## Event mapping

| OpenClaw event | Opik entity | Notes |
| --- | --- | --- |
| `llm_input` | trace + llm span | starts trace and llm span |
| `llm_output` | llm span update/end | writes usage/output and closes span |
| `before_tool_call` | tool span start | captures tool name + input |
| `after_tool_call` | tool span update/end | captures output/error + duration |
| `subagent_spawning` | subagent span start | starts subagent lifecycle span on requester trace |
| `subagent_spawned` | subagent span update | enriches subagent span with run metadata |
| `subagent_ended` | subagent span update/end | finalizes subagent span with outcome/error |
| `agent_end` | trace finalize | closes pending spans and trace |

## Known limitation

No OpenClaw core changes are included in this repository and relies on native hooks within the OpenClaw ecosystem.

## Development

Prerequisites:

- Node.js `>=22.12.0`
- npm `>=10`

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

[Apache-2.0](./LICENSE)
