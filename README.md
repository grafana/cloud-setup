# 🦕 @grafana/cloud-setup

> [!IMPORTANT]
> This tool is in _public preview_ and may change in future releases.

Grafana Cloud's interactive setup wizard, powered by Grafana Assistant.

Sets up **Synthetics** or **Frontend Observability** in your project, installing `gcx` and agent skills along the way.

### Requirements

- Node.js >= 22.6.0
- A Grafana Cloud stack (e.g. `https://my-team.grafana.net`)
  - Don't have one? [Sign up for free](https://grafana.com/auth/sign-up/create-user)

### Usage

```sh
npx @grafana/cloud-setup <command> # e.g. synthetics
```

<img src="/media/screenshot.png" />

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

## Telemetry

Set `CLOUD_SETUP_TELEMETRY=disabled` or `DO_NOT_TRACK=1` to opt out from anonymous usage statistics.

See `src/telemetry.ts` for what's collected.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and toolchain.

## License

Apache-2.0
