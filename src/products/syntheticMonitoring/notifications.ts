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

interface ReceiverIntegration {
  uid?: string;
  type: string;
  version: string;
  settings: { addresses?: string; [key: string]: unknown };
  disableResolveMessage?: boolean;
  secureFields?: Record<string, boolean>;
  [key: string]: unknown;
}

// These resources are read, amended and PUT back whole. Keep fields this
// client doesn't model, including provenance and stored-secret references.
interface ResourceMetadata {
  name?: string;
  namespace?: string;
  resourceVersion?: string;
  [key: string]: unknown;
}

interface Receiver {
  metadata: ResourceMetadata;
  spec: {
    title: string;
    integrations: ReceiverIntegration[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ReceiverList {
  metadata?: { continue?: string };
  items: Receiver[];
}

interface Route {
  receiver?: string;
  matchers?: { label: string; type: string; value: string }[];
  routes?: Route[];
  [key: string]: unknown;
}

interface RoutingTree {
  metadata: ResourceMetadata;
  spec: {
    defaults: { receiver: string; [key: string]: unknown };
    routes: Route[];
    [key: string]: unknown;
  };
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
    matchers: [{ label: "namespace", type: "=", value: SM_NAMESPACE_LABEL }],
    group_by: SM_ROUTE_GROUP_BY,
    // Stops here rather than also reaching the root receiver, which on a
    // fresh stack is an undeliverable placeholder address.
    continue: false,
  };
}

function routesSmNamespace(route: Route): boolean {
  return (route.matchers ?? []).some(
    ({ label, type, value }) =>
      label === "namespace" && (type === "=" || type === "=~") && value === SM_NAMESPACE_LABEL,
  );
}

const NOTIFICATIONS_API_VERSION = "notifications.alerting.grafana.app/v1beta1";
// SM rules use the default policy tree. An additional named tree would not
// receive their alerts without changing the rules' notification settings.
const DEFAULT_ROUTING_TREE_NAME = "user-defined";
const MAX_WRITE_ATTEMPTS = 3;

export class AlertingApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
  }
}

export class AlertingClient {
  private namespace?: Promise<string>;

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
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok)
      throw new AlertingApiError(
        `Grafana Alerting API ${method} ${path} failed with status ${res.status}`,
        res.status,
        text,
      );
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private getNamespace(): Promise<string> {
    // Use Grafana's namespace, just as its frontend does. Neither a stack ID
    // nor an organization ID is itself an API namespace.
    return (this.namespace ??= this.request<{ namespace?: string }>("GET", "/api/frontend/settings").then(
      ({ namespace }) => {
        if (typeof namespace !== "string" || !namespace.trim()) {
          throw new Error("Grafana did not return an API namespace");
        }
        return namespace;
      },
    ));
  }

  private async resourcePath(resource: string): Promise<string> {
    return `/apis/${NOTIFICATIONS_API_VERSION}/namespaces/${encodeURIComponent(await this.getNamespace())}/${resource}`;
  }

  private async findContactPoint(): Promise<Receiver | undefined> {
    const path = await this.resourcePath("receivers");
    let cursor: string | undefined;
    do {
      const page: ReceiverList = await this.request(
        "GET",
        cursor ? `${path}?continue=${encodeURIComponent(cursor)}` : path,
      );
      const receiver = page.items.find((item) => item.spec.title === SM_CONTACT_POINT_NAME);
      if (receiver) return receiver;
      cursor = page.metadata?.continue;
    } while (cursor);
    return undefined;
  }

  private async getPolicyTree(): Promise<RoutingTree> {
    return this.request("GET", await this.resourcePath(`routingtrees/${DEFAULT_ROUTING_TREE_NAME}`));
  }

  private async updateResource(resource: string, value: Receiver | RoutingTree): Promise<void> {
    const { name, resourceVersion } = value.metadata;
    if (!name || !resourceVersion) {
      throw new Error(`Grafana Alerting ${resource} resource is missing a name or resource version`);
    }
    await this.request("PUT", await this.resourcePath(`${resource}/${encodeURIComponent(name)}`), value);
  }

  private async retryOnConflict<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof AlertingApiError) || error.status !== 409 || attempt >= MAX_WRITE_ATTEMPTS) {
          throw error;
        }
        // Reread and merge into the latest resource instead of resending a
        // stale snapshot that could discard a concurrent edit.
      }
    }
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
    const [receiver, userEmail] = await Promise.all([this.findContactPoint(), this.currentUserEmail()]);
    const email = receiver?.spec.integrations.find((integration) => integration.type === "email");
    return { existingAddresses: email?.settings.addresses?.trim() || undefined, userEmail };
  }

  async ensureContactPoint(addresses: string): Promise<"created" | "updated" | "unchanged"> {
    return this.retryOnConflict(async () => {
      const existing = await this.findContactPoint();
      const email: ReceiverIntegration = {
        type: "email",
        version: "v1",
        settings: { addresses },
        disableResolveMessage: false,
      };
      if (!existing) {
        await this.request("POST", await this.resourcePath("receivers"), {
          apiVersion: NOTIFICATIONS_API_VERSION,
          kind: "Receiver",
          // Grafana assigns metadata.name. In this API, omitting provenance
          // leaves new receivers editable. Updates retain existing metadata.
          metadata: { namespace: await this.getNamespace() },
          spec: { title: SM_CONTACT_POINT_NAME, integrations: [email] },
        });
        return "created";
      }
      const index = existing.spec.integrations.findIndex((integration) => integration.type === "email");
      const current = existing.spec.integrations[index];
      if (current?.settings.addresses?.trim() === addresses) return "unchanged";
      const integrations = [...existing.spec.integrations];
      if (current) integrations[index] = { ...current, settings: { ...current.settings, addresses } };
      else integrations.push(email);
      await this.updateResource("receivers", {
        ...existing,
        spec: { ...existing.spec, integrations },
      });
      return "updated";
    });
  }

  async ensureRoute(): Promise<"created" | "unchanged"> {
    return this.retryOnConflict(async () => {
      const tree = await this.getPolicyTree();
      const routes = tree.spec.routes;
      if (routes.some((r) => r.receiver === SM_CONTACT_POINT_NAME && routesSmNamespace(r))) return "unchanged";
      // Appended so existing policies keep their precedence. Preserve the
      // default receiver, nested policies, metadata and resource version.
      await this.updateResource("routingtrees", {
        ...tree,
        spec: { ...tree.spec, routes: [...routes, smRoute()] },
      });
      return "created";
    });
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
