import { SmApiError } from "../../products/syntheticMonitoring/api.js";
import { AlertingApiError } from "../../products/syntheticMonitoring/notifications.js";

export function isAuthorizationError(error: unknown): boolean {
  return (error instanceof SmApiError || error instanceof AlertingApiError) && [401, 403].includes(error.status);
}

export function apiErrorMessage(error: unknown, forbiddenMessage = "Permission denied (403)."): string {
  if (error instanceof SmApiError || error instanceof AlertingApiError) {
    if (error.status === 403) return forbiddenMessage;
    if (error.status === 401) return "Authentication failed (401). Sign in again or use a valid access token.";
    try {
      const body = JSON.parse(error.body) as { message?: unknown } | null;
      if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
    } catch {
      // Plain-text API errors can be useful too, but keep HTML out of the terminal.
      const body = error.body.trim();
      if (body && !body.startsWith("<")) return body;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export const SM_WRITE_DENIED =
  "Permission denied. Ask a stack administrator to grant Synthetic Monitoring write access.";
