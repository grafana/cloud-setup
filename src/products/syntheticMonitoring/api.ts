export interface Probe {
  id: number;
  name: string;
}

export interface RemoteCheck {
  id: number;
  tenantId: number;
  target: string;
  job: string;
  frequency: number;
  timeout: number;
  enabled: boolean;
  alertSensitivity: string;
  basicMetricsOnly: boolean;
  probes: number[];
  labels: { name: string; value: string }[];
  settings: Record<string, unknown>;
  created: number;
  modified: number;
}

export class SmApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string
  ) {
    super(message);
  }
}

// "direct": the classic path — a real SM API base URL + a pasted SM access
// token, talking to the SM API itself.
// "proxy": routes through Grafana's own datasource-proxy on the stack,
// using the Grafana Assistant OAuth session's access token — the SM API
// token is injected server-side by the SM plugin's proxy route, so this
// tool never sees or manages one. Verified live against a real stack;
// mirrors gcx's own SM transport (github.com/grafana/gcx
// internal/query/synth) — see src/smAuth.ts for how the proxyBase and
// datasourceUid are discovered.
export type SmTransport =
  | { mode: "direct"; baseUrl: string; token: string }
  | { mode: "proxy"; proxyBase: string; datasourceUid: string; accessToken: string };

export class SmClient {
  constructor(private transport: SmTransport) {}

  // SM API paths here are relative to the API's own /api/v1 root either
  // way — only the prefix in front of them differs between transports.
  private urlFor(smPath: string): string {
    return this.transport.mode === "direct"
      ? `${this.transport.baseUrl}/api/v1/${smPath}`
      : `${this.transport.proxyBase}/api/datasources/proxy/uid/${this.transport.datasourceUid}/sm/${smPath}`;
  }

  private async request<T>(method: string, smPath: string, body?: unknown): Promise<T> {
    const token = this.transport.mode === "direct" ? this.transport.token : this.transport.accessToken;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    // Lets the SM API attribute proxy-mode traffic to this tool in its own
    // request logs instead of logging it as an unknown client (mirrors
    // gcx's identical use of this header on the same proxy route).
    if (this.transport.mode === "proxy") headers["X-Client-Id"] = "grafana-synthetics-cli";

    const res = await fetch(this.urlFor(smPath), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });

    const text = await res.text();
    if (!res.ok) {
      throw new SmApiError(`${method} ${smPath} failed with status ${res.status}`, res.status, text);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  listChecks(): Promise<RemoteCheck[]> {
    return this.request("GET", "check/list");
  }

  async findCheck(job: string, target: string): Promise<RemoteCheck | undefined> {
    try {
      return await this.request<RemoteCheck>("GET", `check/query?job=${encodeURIComponent(job)}&target=${encodeURIComponent(target)}`);
    } catch (err) {
      if (err instanceof SmApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  createCheck(payload: Record<string, unknown>): Promise<RemoteCheck> {
    return this.request("POST", "check/add", payload);
  }

  updateCheck(payload: Record<string, unknown>): Promise<RemoteCheck> {
    return this.request("POST", "check/update", payload);
  }

  deleteCheck(id: number): Promise<void> {
    return this.request("DELETE", `check/delete/${id}`);
  }

  listProbes(): Promise<Probe[]> {
    return this.request("GET", "probe/list");
  }
}
