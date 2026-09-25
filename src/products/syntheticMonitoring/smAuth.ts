import { ensureAssistantAuth } from "../../harness/index.js";
import { SmClient, type Probe } from "./api.js";

export interface AutoSmSession {
  client: SmClient;
  probes: Probe[];
  // Best-effort real SM API URL, for probe location preferences, display,
  // and Terraform export. Never used to build requests in proxy mode.
  apiUrl?: string;
}

async function discoverDatasourceUid(proxyBase: string, accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${proxyBase}/api/datasources`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return undefined;
    const datasources = (await res.json()) as Array<{ uid?: string; type?: string }>;
    return datasources.find((d) => d.type === "synthetic-monitoring-datasource")?.uid;
  } catch {
    return undefined;
  }
}

// Mirrors gcx's own discoverSMURL (github.com/grafana/gcx
// internal/providers/synth/provider.go) — reads the real SM API base URL
// out of the SM plugin's own settings. A failure never blocks check creation:
// probe selection falls back to region diversity and Terraform's sm_url is
// left for the user to fill in.
async function discoverApiUrl(proxyBase: string, accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${proxyBase}/api/plugins/grafana-synthetic-monitoring-app/settings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { jsonData?: { apiHost?: string } };
    return body.jsonData?.apiHost || undefined;
  } catch {
    return undefined;
  }
}

// Tries to set up Synthetic Monitoring access with zero manual input, by
// reusing the same Grafana Assistant OAuth session ("Authenticate with
// OAuth") through Grafana's own datasource-proxy route — the exact
// mechanism gcx itself uses (github.com/grafana/gcx internal/query/synth +
// internal/datasources/query), verified live against a real stack:
//   - the proxy route is reached at {apiEndpoint}/api/cli/v1/proxy
//   - the SM datasource's own plugin type is "synthetic-monitoring-datasource"
//   - SM API paths are forwarded verbatim under .../sm/<path>
//
// Returns undefined on any failure (no OAuth session, insufficient role,
// SM not provisioned as a datasource on this stack, ...) — callers should
// fall back to the manual base-url/token flow, exactly as before this
// existed.
export async function tryAutoSmSession(stackUrl: string): Promise<AutoSmSession | undefined> {
  try {
    const tokens = await ensureAssistantAuth(stackUrl);
    const proxyBase = `${tokens.apiEndpoint}/api/cli/v1/proxy`;

    const datasourceUid = await discoverDatasourceUid(proxyBase, tokens.accessToken);
    if (!datasourceUid) return undefined;

    const client = new SmClient({ mode: "proxy", proxyBase, datasourceUid, accessToken: tokens.accessToken });
    const probes = await client.listProbes();
    const apiUrl = await discoverApiUrl(proxyBase, tokens.accessToken);

    return { client, probes, apiUrl };
  } catch {
    return undefined;
  }
}
