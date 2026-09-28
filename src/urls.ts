export type UrlKind = "target" | "stack" | "collector";

export type UrlResult = { url: string; error?: never } | { url?: never; error: string };

// Validate before URL's permissive parser can repair malformed schemes or
// backslashes. A missing scheme is fine, but an incomplete one is a typo.
export function validateSetupUrl(value: string, kind: UrlKind): UrlResult {
  const raw = value.trim();
  const { example, label } = {
    target: { example: "https://example.com", label: "target URL" },
    stack: { example: "https://my-team.grafana.net", label: "Grafana Cloud stack slug or URL" },
    collector: { example: "https://collector.example/collect/key", label: "Faro collector URL" },
  }[kind];
  const invalid = {
    error:
      kind === "stack"
        ? `Enter a stack slug, for example my-team, or a valid HTTP or HTTPS URL, for example ${example}.`
        : `Enter a valid HTTP or HTTPS URL, for example ${example}.`,
  };
  if (!raw) {
    return { error: `Enter the ${label} to continue.` };
  }
  if (/[\s\\]/.test(raw)) return invalid;
  if (/^https?\//i.test(raw)) return invalid;
  if (/^https?:/i.test(raw) && !/^https?:\/\/[^/]/i.test(raw)) return invalid;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return invalid;
  if (/^[/?#]/.test(raw)) return invalid;

  // A bare stack name is shorthand for a single grafana.net hostname label.
  // Inputs with a dot or colon take the URL path below, including malformed
  // schemes. Never fall back to slug expansion after URL validation fails.
  if (kind === "stack" && !/[.:]/.test(raw)) {
    if (!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(raw)) return invalid;
    return { url: `https://${raw.toLowerCase()}.grafana.net` };
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return invalid;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return invalid;
  if (parsed.username || parsed.password) return { error: "Enter a URL without a username or password." };
  if (kind === "stack") {
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return { error: `Enter the stack's base URL without a path, query, or fragment, for example ${example}.` };
    }
    return { url: parsed.origin };
  }
  return { url: parsed.href };
}
