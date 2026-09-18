import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { cancelledPage, successPage } from "./authPage.js";

export interface AssistantTokens {
  accessToken: string;
  refreshToken: string;
  apiEndpoint: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Nothing here is persisted to disk — every run signs in fresh. This cache
// is purely in-memory and process-lifetime, so the several calls a single
// run makes (the explicit "auth" step, then authorChecks' own warm-up call,
// then each runTask underneath it) share one login instead of popping a
// browser window open repeatedly for the same run.
const sessionTokens = new Map<string, AssistantTokens>();

function normalizeStackUrl(stackUrl: string): string {
  const withProtocol = /^https?:\/\//.test(stackUrl) ? stackUrl : `https://${stackUrl}`;
  return withProtocol.endsWith("/") ? withProtocol.slice(0, -1) : withProtocol;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", '""', url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

interface PKCE {
  codeVerifier: string;
  codeChallenge: string;
}

function generatePKCE(): PKCE {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// Same connect flow k6 Studio uses (verified against its source): a
// Grafana-hosted consent page on the target stack itself, PKCE-protected,
// redirecting back to a local callback server we spin up for this.
function buildAssistantAuthUrl(stackUrl: string, codeChallenge: string, state: string, callbackPort: number): string {
  // "cli/auth", not "connect/app" — verified live that connect/app rejects
  // grafana-api:* scopes ("invalid scope") while cli/auth (gcx's own path,
  // confirmed against its source) accepts them.
  const url = new URL("/a/grafana-assistant-app/cli/auth", normalizeStackUrl(stackUrl));
  url.searchParams.set("callback_port", String(callbackPort));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Matches gcx's own defaultScopes exactly (verified against its source,
  // github.com/grafana/gcx internal/auth/flow.go) — grafana-api:* is what
  // lets the resulting token drive Grafana's own datasource-proxy route
  // (used below for Synthetic Monitoring), not just the assistant:* scopes
  // this tool used to request.
  url.searchParams.set("scopes", "grafana-api:read,grafana-api:write,grafana-api:delete,assistant:a2a,assistant:chat");
  url.searchParams.set("device_name", "cloud-setup");
  return url.toString();
}

interface CallbackResult {
  code: string;
  state: string;
  endpoint: string | null;
}

// The callback can hand back a different (e.g. regional) API host than the
// stack URL we started from — only trust it if it's the same host or a real
// Grafana Cloud domain, mirroring k6 Studio's isAllowedEndpoint check.
function isAllowedEndpoint(endpoint: string, stackUrl: string): boolean {
  try {
    const endpointHost = new URL(endpoint).hostname;
    const stackHost = new URL(normalizeStackUrl(stackUrl)).hostname;
    return endpointHost === stackHost || endpointHost.endsWith(".grafana.net") || endpointHost.endsWith(".grafana-dev.net");
  } catch {
    return false;
  }
}

async function startCallbackServer(signal?: AbortSignal): Promise<{ port: number; result: Promise<CallbackResult> }> {
  const server = http.createServer({ keepAliveTimeout: 0 });
  let resolve!: (value: CallbackResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<CallbackResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // Without this, a browser tab the user never gets to (or never completes)
  // leaves this awaiting forever — the whole setup wizard just looks stuck,
  // with no clue why. Cleared below wherever the promise settles first.
  const timer = setTimeout(() => {
    reject(new Error(`Timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s waiting for Grafana Assistant sign-in.`));
  }, LOGIN_TIMEOUT_MS);

  // Lets a caller bail out well before that 5-minute timeout — e.g. the
  // user pressing a "cancel" key while the wizard waits on this — without
  // leaving the server or the timer running in the background.
  const onAbort = () => reject(new Error("cancelled"));
  signal?.addEventListener("abort", onAbort);

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const endpoint = url.searchParams.get("endpoint");
    const isSuccess = !error && code && state;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(isSuccess ? successPage() : cancelledPage(), () => {
      if (error) reject(new Error(`Authorization denied: ${error}`));
      else if (code && state) resolve({ code, state, endpoint });
      else reject(new Error("Missing code or state in auth callback"));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const closeAfter = promise.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    server.close();
    server.closeAllConnections();
  });
  closeAfter.catch(() => {});

  return { port, result: closeAfter };
}

const ExchangeResponseSchema = z.object({
  data: z.object({
    token: z.string(),
    refresh_token: z.string(),
    expires_at: z.string(),
    refresh_expires_at: z.string(),
    api_endpoint: z.string(),
  }),
});

// The assistant-app error envelope is `{message, name, traceId, ...}` — this
// surfaces just `message` (what a user can actually act on) instead of the
// raw JSON blob, which is what ends up in a CLI line like "Skipping
// AI-powered suggestions (...)" otherwise. Falls back to the raw body only
// when it isn't that shape, so nothing is silently swallowed.
async function describeErrorResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => "unknown error");
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string") {
      return (body as { message: string }).message;
    }
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return text;
}

async function exchangeCode(stackUrl: string, code: string, codeVerifier: string): Promise<AssistantTokens> {
  const res = await fetch(`${normalizeStackUrl(stackUrl)}/api/cli/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`Assistant auth exchange failed (${res.status}): ${await describeErrorResponse(res)}`);
  }
  const body = ExchangeResponseSchema.parse(await res.json());
  return {
    accessToken: body.data.token,
    refreshToken: body.data.refresh_token,
    apiEndpoint: body.data.api_endpoint,
    expiresAt: new Date(body.data.expires_at).getTime(),
    refreshExpiresAt: new Date(body.data.refresh_expires_at).getTime(),
  };
}

async function performInteractiveLogin(stackUrl: string, signal?: AbortSignal): Promise<AssistantTokens> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = generateState();
  const { port, result } = await startCallbackServer(signal);
  const authUrl = buildAssistantAuthUrl(stackUrl, codeChallenge, state, port);

  openBrowser(authUrl);

  const callback = await result;
  if (callback.state !== state) {
    throw new Error("State mismatch in assistant auth callback (possible CSRF) — please retry");
  }
  if (!callback.endpoint || !isAllowedEndpoint(callback.endpoint, stackUrl)) {
    throw new Error(`Unexpected or missing API endpoint from auth callback: ${callback.endpoint}`);
  }

  return exchangeCode(callback.endpoint, callback.code, codeVerifier);
}

// Ensures a valid Grafana Assistant access token for the given stack, for
// the lifetime of this process only — nothing is written to disk, and
// nothing from a previous run is ever trusted. Reuses this run's own token
// if it's not expiring soon; otherwise runs the full interactive
// OAuth-PKCE flow (opens a browser). Callers are expected to have already
// gotten the user's OK for that browser to open — this never asks itself.
// An optional `signal` lets a caller abort a pending interactive login
// early (e.g. useAuthStep's own cancel keybind) rather than only ever
// giving up after the 5-minute callback timeout.
export async function ensureAssistantAuth(stackUrl: string, signal?: AbortSignal): Promise<AssistantTokens> {
  const cached = sessionTokens.get(stackUrl);
  if (cached && Date.now() + REFRESH_THRESHOLD_MS < cached.expiresAt) return cached;

  const tokens = await performInteractiveLogin(stackUrl, signal);
  sessionTokens.set(stackUrl, tokens);
  return tokens;
}
