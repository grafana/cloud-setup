# setup-cli

Grafana Cloud's interactive setup wizard, powered by Assistant.

Configures gcx, installs agent skills, and sets up Grafana products in your project.

Supported products:
- Synthetic Monitoring

## Usage

```sh
npm install && npm run build && npm link

npx @grafana/setup-cli synthetics --url https://example.com --stack https://my-team.grafana.net
```
