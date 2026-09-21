# @grafana/cloud-setup

> **⚠️ Important:** This is a development preview and may change in future releases.

Grafana Cloud's interactive setup wizard, powered by Grafana Assistant. 

Sets up **Synthetics** or **Frontend Observability** in your project, installing `gcx` and agent skills along the way.

### Requirements
- Node.js >= 22.6.0
- A Grafana Cloud stack (e.g. `https://my-team.grafana.net`)

### Usage
```sh
npx @grafana/cloud-setup <command> # e.g. synthetics
```

<img alt="Screenshot 2026-09-21 at 12 03 22" src="https://github.com/user-attachments/assets/50cb5a9c-41d9-48b4-b213-7ba537704ca5" />

## Reference

### `synthetics`

```sh
npx @grafana/cloud-setup synthetics --url https://example.com --stack https://my-team.grafana.net
```

| Flag | Description |
| --- | --- |
| `--url <url>` | Target URL to check (required) |
| `--stack <url>` | Grafana Cloud stack URL (required) |
| `--folder <path>` | Project directory to set up (default: `.`) |
| `--debug` | Log raw Assistant tool calls/responses to a temp file, for troubleshooting |

### `frontend`

```sh
npx @grafana/cloud-setup frontend --stack https://my-team.grafana.net
```

| Flag | Description |
| --- | --- |
| `--stack <url>` | Grafana Cloud stack URL (required) |
| `--app <name>` | Frontend Observability app to attach to (skips the picker if it exists) |
| `--folder <path>` | Project directory to set up (default: `.`) |
| `--session-replay` | Also wire in Session Replay (beta; must be separately enabled on your stack) |
| `--debug` | Log raw Assistant tool calls/responses to a temp file, for troubleshooting |

## Development

```sh
npm install
npm run build
npm link
```


## License

Apache-2.0
