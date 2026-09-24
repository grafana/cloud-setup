# 🦕 @grafana/cloud-setup

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

### How is this different from `gcx`?

This wizard is interactive and built for humans. It walks you through onboarding a new product, step by step.

`gcx` is the non-interactive CLI underneath, built for agents and automation to work with our products continuously.

You'll be relying on it directly from day 2 onward, which is why this wizard sets it up for you.

## Reference

### `synthetics`

Set up Synthetic Monitoring checks.

```sh
npx @grafana/cloud-setup synthetics --url https://example.com --stack my-team
```

| Flag              | Description                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| `--url <url>`     | Target URL to check (required)                                             |
| `--stack <slug>`  | Grafana Cloud stack slug, e.g. `my-team` (URLs also accepted)              |
| `--folder <path>` | Project directory to set up (default: `.`)                                 |
| `--debug`         | Log raw Assistant tool calls/responses to a temp file, for troubleshooting |

### `frontend`

Instrument local app with Frontend Observability.

```sh
npx @grafana/cloud-setup frontend --stack my-team
```

| Flag              | Description                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| `--stack <slug>`  | Grafana Cloud stack slug, e.g. `my-team` (URLs also accepted)              |
| `--app <name>`    | Frontend Observability app to attach to (skips the picker if it exists)    |
| `--folder <path>` | Project directory to set up (default: `.`)                                 |
| `--debug`         | Log raw Assistant tool calls/responses to a temp file, for troubleshooting |

## Exit status

The wizard exits with code `0` after successful setup, deliberate skips, or user cancellation. It exits with code `1` when required setup is incomplete or an error stops the run. Files already changed and checks already created remain in place. The final screen identifies unfinished work and how to continue.

For example, a failed Faro package installation or failed Synthetics alert configuration produces an incomplete result, even if instrumentation files or checks were created successfully. A failure in optional endpoint discovery does not invalidate checks that are already configured.

## Development

```sh
npm install
npm run build
npm link
```

## Telemetry

Reports anonymous usage statistics by default. Set `CLOUD_SETUP_TELEMETRY=disabled` or `DO_NOT_TRACK=1` to opt out.

See `src/telemetry.ts` for what's collected.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and toolchain.

## License

Apache-2.0
