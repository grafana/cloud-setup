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

export class SmClient {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new SmApiError(`${method} ${urlPath} failed with status ${res.status}`, res.status, text);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  listChecks(): Promise<RemoteCheck[]> {
    return this.request("GET", "/api/v1/check/list");
  }

  async findCheck(job: string, target: string): Promise<RemoteCheck | undefined> {
    try {
      return await this.request<RemoteCheck>(
        "GET",
        `/api/v1/check/query?job=${encodeURIComponent(job)}&target=${encodeURIComponent(target)}`
      );
    } catch (err) {
      if (err instanceof SmApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  createCheck(payload: Record<string, unknown>): Promise<RemoteCheck> {
    return this.request("POST", "/api/v1/check/add", payload);
  }

  updateCheck(payload: Record<string, unknown>): Promise<RemoteCheck> {
    return this.request("POST", "/api/v1/check/update", payload);
  }

  deleteCheck(id: number): Promise<void> {
    return this.request("DELETE", `/api/v1/check/delete/${id}`);
  }

  listProbes(): Promise<Probe[]> {
    return this.request("GET", "/api/v1/probe/list");
  }
}
