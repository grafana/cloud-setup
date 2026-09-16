# cloud-setup

> **Note:** This is a prototype and may change in future releases.

Grafana Cloud's interactive setup wizard, powered by Grafana Assistant.

Installs gcx, configures agent skills, and sets up Synthetic Monitoring or Frontend Observability in your project.

## Usage

```sh
npm install && npm run build && npm link

npx @grafana/cloud-setup synthetics --url https://example.com --stack https://my-team.grafana.net

npx @grafana/cloud-setup frontend --stack https://my-team.grafana.net
```
