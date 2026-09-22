import { ensureAssistantAuth } from "../../harness/index.js";

export interface FaroApp {
  id: string;
  name: string;
  appKey: string;
  collectEndpointURL: string;
  // The app's CORS allow-list — verified against gcx's own types.go
  // (github.com/grafana/gcx internal/providers/faro/types.go) as the one
  // field on a Faro app that actually names the site(s) it covers. Origins
  // only (scheme+host+port, e.g. "https://example.com"), never a full URL
  // with a path.
  corsOrigins: string[];
}

interface FaroAppApi {
  id?: number;
  name: string;
  appKey?: string;
  collectEndpointURL?: string;
  corsOrigins?: { url: string }[];
}

function fromApi(api: FaroAppApi): FaroApp {
  return {
    id: String(api.id ?? ""),
    name: api.name,
    appKey: api.appKey ?? "",
    collectEndpointURL: api.collectEndpointURL ?? "",
    corsOrigins: (api.corsOrigins ?? []).map((o) => o.url),
  };
}

// Verified against gcx's own source (github.com/grafana/gcx
// internal/providers/faro/client.go) — same plugin-proxy path it uses.
const FARO_BASE_PATH = "/api/plugin-proxy/grafana-kowalski-app/api-proxy/api/v1/app";

export class FaroClient {
  constructor(
    private proxyBase: string,
    private accessToken: string
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.proxyBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        // Mirrors gcx's identical use of this header on the same proxy route.
        "X-Client-Id": "grafana-synthetics-cli",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Faro API ${method} ${path} failed with status ${res.status}: ${text}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async list(): Promise<FaroApp[]> {
    const apps = await this.request<FaroAppApi[]>("GET", FARO_BASE_PATH);
    return apps.map(fromApi);
  }

  // Creating an app via this route is NOT attempted — verified live
  // (reproduced with gcx's own official implementation, not just ours)
  // that it 403s for OAuth tokens regardless of scope: this specific
  // plugin-proxy route only accepts a real Service Account token for
  // writes. See github.com/grafana/gcx issues #435 and #433 — Grafana's
  // own team extended OAuth to cover *reads* on this route, but never
  // extended it to writes. list() above only works because of that fix.
  async findExisting(name: string): Promise<FaroApp | undefined> {
    return (await this.list()).find((a) => a.name === name);
  }
}

// Reuses the same "Authenticate with OAuth" session used for Synthetic
// Monitoring — same proxy mechanism, verified live, just a different
// plugin-proxy path. Returns undefined on any failure (no OAuth session,
// insufficient role, ...); callers should treat Frontend O11y setup as a
// nice-to-have that degrades gracefully.
export async function tryFaroClient(stackUrl: string): Promise<FaroClient | undefined> {
  try {
    const tokens = await ensureAssistantAuth(stackUrl);
    return new FaroClient(`${tokens.apiEndpoint}/api/cli/v1/proxy`, tokens.accessToken);
  } catch {
    return undefined;
  }
}
