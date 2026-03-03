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
    OpenClaw Opik Plugin
  </div>
</h1>

<p align="center">
Community plugin for <a href="https://github.com/openclaw/openclaw">OpenClaw</a> that exports agent traces to <a href="https://www.comet.com/docs/opik/">Opik</a>.
</p>

<div align="center">

[![License](https://img.shields.io/npm/l/%40opik%2Fopik-openclaw)](https://www.npmjs.com/package/@opik/opik-openclaw)
[![npm version](https://img.shields.io/npm/v/%40opik%2Fopik-openclaw)](https://www.npmjs.com/package/@opik/opik-openclaw)

</div>

## What this plugin gives you

`@opik/opik-openclaw` adds native Opik tracing for OpenClaw runs:

- LLM request/response spans
- tool call spans with inputs, outputs, and errors
- run-level finalize metadata
- usage and cost metadata

The plugin runs inside the OpenClaw Gateway process. If your gateway is remote, install and configure the plugin on that host.

## First run

### 1. Configure the plugin

```bash
openclaw opik configure
```

The setup wizard validates endpoint and credentials, then writes config under `plugins.entries.opik`.

### 2. Check effective settings

```bash
openclaw opik status
```

### 3. Send a test message

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
      "opik": {
        "enabled": true,
        "config": {
          "enabled": true,
          "apiKey": "your-api-key",
          "apiUrl": "https://www.comet.com/opik/api",
          "projectName": "openclaw",
          "workspaceName": "default",
          "tags": ["openclaw"],
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

OpenClaw now propagates embedded `after_tool_call` context more reliably (including `sessionKey` and `agentId`, see openclaw/openclaw#32201). This plugin still keeps deterministic fallback logic for older OpenClaw versions where `sessionKey` can be missing; under high-concurrency multi-session workloads, fallback correlation can still misattribute a tool span.

No OpenClaw core changes are included in this repository.

## Development

Prerequisites:

- Node.js `>=22.12.0`
- npm `>=11`

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
