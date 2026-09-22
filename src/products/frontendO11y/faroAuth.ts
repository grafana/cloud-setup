import { ensureAssistantAuth } from "../../harness/index.js";

export interface FaroApp {
  id: string;
  name: string;
  appKey: string;
  collectEndpointURL: string;
}

interface FaroAppApi {
  id?: number;
  name: string;
  appKey?: string;
  collectEndpointURL?: string;
}

function fromApi(api: FaroAppApi): FaroApp {
  return {
    id: String(api.id ?? ""),
    name: api.name,
    appKey: api.appKey ?? "",
    collectEndpointURL: api.collectEndpointURL ?? "",
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

  async findExisting(name: string): Promise<FaroApp | undefined> {
    return (await this.list()).find((a) => a.name === name);
  }

  // Still 403s for OAuth tokens as of 2026-09-22 (re-verified live against
  // a real stack: "plugin proxy route access denied") — the May 2026
  // permission rollout for github.com/grafana/gcx issues #435/#433 only
  // ever covered reads on this route, matching this file's original
  // finding. gcx's own Create() (internal/providers/faro/client.go)
  // hits this exact same path with no OAuth/SA distinction, so it's
  // presumably in the same boat, just untested there. Attempted anyway,
  // with callers expected to fall back on failure (see FrontendApp.tsx):
  // cheap to try, and it starts working for free the day Grafana extends
  // that permission to writes too.
  //
  // The create response is missing collectEndpointURL/appKey (a known
  // API quirk gcx works around the same way), so this re-lists to find
  // the just-created app by name rather than trusting the response body.
  async create(name: string): Promise<FaroApp> {
    await this.request<FaroAppApi>("POST", FARO_BASE_PATH, { name });
    const created = (await this.list()).find((a) => a.name === name);
    if (!created) throw new Error(`Faro app "${name}" was created but didn't show up in the app list afterward`);
    return created;
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
