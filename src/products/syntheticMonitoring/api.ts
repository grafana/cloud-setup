import type { CheckAlert } from "./checkAlerts.js";

// The k6 channel every browser-settings check (SSL, broken-links) here is
// assigned to on create/update — see toPayload in reconcile.ts — and the
// one eligibleProbes (create.ts) checks probes support before assigning
// them to one of those checks.
export const K6_V2_CHANNEL = "v2";

export interface Probe {
  id: number;
  name: string;
  // Older probes predating the k6-based check runner report these — they
  // can't run scripted or browser checks (SSL/broken-links here both use
  // `settings.browser`, i.e. a k6 script) even though they're otherwise
  // healthy and returned by probe/list. See eligibleProbes in create.ts.
  capabilities?: { disableScriptedChecks?: boolean; disableBrowserChecks?: boolean };
  // Per-k6-channel version support, keyed by channel id (e.g. "v1", "v2").
  // A channel present with value `null` means the probe reported k6
  // versions but none satisfy that channel; "unknown" means it hasn't
  // reported any version yet (the API itself allows this case by
  // default); an absent key means this install has no such channel.
  // Only `null` actually means "not eligible" — see eligibleProbes.
  k6Versions?: Record<string, string | null>;
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
  channels?: { k6?: { id: string } } | null;
  created: number;
  modified: number;
}

export class SmApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
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

// 502/503/504 are the standard gateway-can't-reach-origin statuses; 522/524
// are Cloudflare's own timeout variants of the same thing (probe/list has
// been seen failing setup outright on a 522 that would have succeeded a
// couple seconds later). Retried only for GET — a lost response to a
// mutation (create/update/delete) might mean it actually landed, and
// retrying could double it up.
const RETRYABLE_STATUSES = new Set([502, 503, 504, 522, 524]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    for (let attempt = 1; ; attempt++) {
      const res = await fetch(this.urlFor(smPath), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      if (!res.ok) {
        if (method === "GET" && RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new SmApiError(`${method} ${smPath} failed with status ${res.status}`, res.status, text);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    }
  }

  listChecks(): Promise<RemoteCheck[]> {
    return this.request("GET", "check/list");
  }

  async findCheck(job: string, target: string): Promise<RemoteCheck | undefined> {
    try {
      return await this.request<RemoteCheck>(
        "GET",
        `check/query?job=${encodeURIComponent(job)}&target=${encodeURIComponent(target)}`,
      );
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

  // Replaces the check's entire alert set, so a caller touching a
  // pre-existing check should getCheckAlerts first. Answers 202 without
  // the alerts, and the Grafana-managed rules it provisions appear a
  // moment later rather than synchronously.
  async putCheckAlerts(id: number, alerts: CheckAlert[]): Promise<void> {
    await this.request("PUT", `check/${id}/alerts`, { alerts });
  }

  // Entries carry extra status/error fields this doesn't model, since the
  // only question asked of them is whether any exist.
  async getCheckAlerts(id: number): Promise<CheckAlert[]> {
    const res = await this.request<{ alerts?: CheckAlert[] } | undefined>("GET", `check/${id}/alerts`);
    return res?.alerts ?? [];
  }
}
