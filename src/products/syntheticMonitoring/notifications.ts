import { ensureAssistantAuth } from "../../harness/index.js";

// The contact point this wizard owns, rather than editing whatever the
// stack's default route points at: an established stack may hold a
// deliberately chosen address there.
export const SM_CONTACT_POINT_NAME = "synthetic-monitoring-default";

// Every rule the SM API provisions carries this as a label
// (github.com/grafana/synthetic-monitoring-api internal/alerts/rules.go),
// so one route covers every check without knowing which rules exist.
const SM_NAMESPACE_LABEL = "synthetic_monitoring";

// Grafana's default grouping is grafana_folder + alertname, which would
// collapse every check into one notification. instance and job are what
// make them per-check.
const SM_ROUTE_GROUP_BY = ["grafana_folder", "alertname", "instance", "job"];

// Several addresses live in one string, which Grafana splits on "," ";"
// or newline (grafana/grafana pkg/util/split_email.go).
const ADDRESS_SEPARATOR = ";";

interface ContactPoint {
  uid?: string;
  name: string;
  type: string;
  settings?: { addresses?: string };
  disableResolveMessage?: boolean;
}

// Read, amended and PUT back whole, so fields this doesn't model still
// have to survive the round trip — dropping one would silently
// reconfigure the user's routing. Hence the index signature.
interface Route {
  receiver?: string;
  object_matchers?: [string, string, string][];
  routes?: Route[];
  [key: string]: unknown;
}

export interface AlertingInspection {
  // Already on SM_CONTACT_POINT_NAME, so a re-run confirms rather than
  // retypes.
  existingAddresses?: string;
  userEmail?: string;
}

export function joinAddresses(addresses: string[]): string {
  return addresses.join(ADDRESS_SEPARATOR);
}

export function parseAddresses(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Loose on purpose: only worth catching a typo obvious enough to warrant
// another go, since Grafana is what ultimately has to accept the address.
export function isEmailish(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function smRoute(): Route {
  return {
    receiver: SM_CONTACT_POINT_NAME,
    object_matchers: [["namespace", "=", SM_NAMESPACE_LABEL]],
    group_by: SM_ROUTE_GROUP_BY,
    // Stops here rather than also reaching the root receiver, which on a
    // fresh stack is an undeliverable placeholder address.
    continue: false,
  };
}

function routesSmNamespace(route: Route): boolean {
  // The older string `matchers` form isn't checked: a route written that
  // way would mean one redundant route, not a broken one.
  return (route.object_matchers ?? []).some(
    ([label, op, value]) => label === "namespace" && (op === "=" || op === "=~") && value === SM_NAMESPACE_LABEL,
  );
}

// Marked deprecated in favour of /apis for Grafana 13+, but still
// functional, and what the SM API itself calls against live stacks
// (github.com/grafana/synthetic-monitoring-api internal/hg/client.go).
const PROVISIONING_BASE = "/api/v1/provisioning";

// Grafana's access-control errors (and most others) are JSON with a
// human-readable `message` — e.g. "You'll need additional permissions...".
// Surfacing that instead of the raw body avoids dumping accessErrorId/title
// and JSON punctuation into a message a user just has to read as prose.
function extractErrorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text;
}

export class AlertingClient {
  constructor(
    private proxyBase: string,
    private accessToken: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.proxyBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        // Mirrors the same header the SM and Faro clients set on this proxy.
        "X-Client-Id": "grafana-synthetics-cli",
        ...(body !== undefined
          ? {
              "Content-Type": "application/json",
              // Required, not an optimisation: without it these writes are
              // stamped with API provenance, which makes the contact point
              // and the whole notification policy tree read-only in the
              // Grafana UI. Granted to the Admin and Editor basic roles.
              "X-Disable-Provenance": "true",
            }
          : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Grafana Alerting API ${method} ${path} failed with status ${res.status}: ${extractErrorMessage(text)}`,
      );
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private listContactPoints(): Promise<ContactPoint[]> {
    return this.request("GET", `${PROVISIONING_BASE}/contact-points`);
  }

  private getPolicyTree(): Promise<Route> {
    return this.request("GET", `${PROVISIONING_BASE}/policies`);
  }

  // Best-effort: a failure only costs the input its prefill.
  private async currentUserEmail(): Promise<string | undefined> {
    try {
      const user = await this.request<{ email?: string }>("GET", "/api/user");
      return user?.email || undefined;
    } catch {
      return undefined;
    }
  }

  // Read up front so the email prompt can be prefilled, and so a failure
  // here rules out the whole notification half before anything is written.
  async inspect(): Promise<AlertingInspection> {
    const [contactPoints, userEmail] = await Promise.all([this.listContactPoints(), this.currentUserEmail()]);
    const own = contactPoints.find((cp) => cp.name === SM_CONTACT_POINT_NAME);
    return { existingAddresses: own?.settings?.addresses?.trim() || undefined, userEmail };
  }

  async ensureContactPoint(addresses: string): Promise<"created" | "updated" | "unchanged"> {
    const existing = (await this.listContactPoints()).find((cp) => cp.name === SM_CONTACT_POINT_NAME);
    if (!existing) {
      await this.request("POST", `${PROVISIONING_BASE}/contact-points`, {
        name: SM_CONTACT_POINT_NAME,
        type: "email",
        settings: { addresses },
        disableResolveMessage: false,
      });
      return "created";
    }
    if (existing.settings?.addresses?.trim() === addresses) return "unchanged";
    // Nothing to address the update at. Surfaced rather than reported as
    // "unchanged", which would be a lie for addresses that differ.
    if (!existing.uid) {
      throw new Error(`Contact point "${SM_CONTACT_POINT_NAME}" already exists but has no UID to update`);
    }
    // Spread so settings this doesn't model (a custom subject, say)
    // survive the update.
    await this.request("PUT", `${PROVISIONING_BASE}/contact-points/${existing.uid}`, {
      ...existing,
      settings: { ...existing.settings, addresses },
    });
    return "updated";
  }

  async ensureRoute(): Promise<"created" | "unchanged"> {
    const tree = await this.getPolicyTree();
    const routes = tree.routes ?? [];
    if (routes.some((r) => r.receiver === SM_CONTACT_POINT_NAME && routesSmNamespace(r))) return "unchanged";
    // Appended rather than prepended, so it never takes precedence over a
    // route someone wrote themselves. The rest of the tree, root receiver
    // included, passes straight back through.
    await this.request("PUT", `${PROVISIONING_BASE}/policies`, { ...tree, routes: [...routes, smRoute()] });
    return "created";
  }
}

// Reuses the "Authenticate with OAuth" session, same as tryAutoSmSession
// and tryFaroClient. Undefined when there's no session to reuse: callers
// fall back to pointing the user at the Alerting UI, since the checks' own
// alerts go over the SM API and don't depend on this.
export async function tryAlertingClient(stackUrl: string): Promise<AlertingClient | undefined> {
  try {
    const tokens = await ensureAssistantAuth(stackUrl);
    return new AlertingClient(`${tokens.apiEndpoint}/api/cli/v1/proxy`, tokens.accessToken);
  } catch {
    return undefined;
  }
}
