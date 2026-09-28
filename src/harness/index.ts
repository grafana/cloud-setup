import { ensureAssistantAuth } from "./auth.js";
import { runAgent, type AgentTool } from "./a2a.js";
import { debugLog } from "../debug.js";

export { ensureAssistantAuth } from "./auth.js";
export { runAgent, type AgentTool } from "./a2a.js";
export { fileTools, fileToolsWithWrite } from "./tools.js";
export { browserTools, type BrowserToolOptions } from "./browserTool.js";

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
// Same statuses SmClient treats as retryable blips (src/products/syntheticMonitoring/api.ts).
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504, 522, 524]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only the shapes that look like a transient blip on the Assistant backend
// rather than a real outcome: the task's own status going to "failed" (as
// opposed to "canceled"/"rejected"/"auth-required", which reflect a
// deliberate decision that a retry won't change), and a 5xx before the SSE
// stream even started. Retrying is safe here because every write-capable
// caller (instrumentNextjs/instrumentReact) already snapshots before
// calling runTask and validates/rolls back after, so a retry that re-runs a
// prompt whose first attempt partially wrote files just re-lands on
// already-done state or gets caught by that validation.
function isRetryableA2AError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "A2A task failed") return true;
  const httpFailure = /^A2A request failed \((\d+)\)/.exec(err.message);
  return httpFailure !== null && RETRYABLE_HTTP_STATUSES.has(Number(httpFailure[1]));
}

// Convenience wrapper for the common case: authenticate against the given
// stack (reusing/refreshing a stored token, or running the interactive
// OAuth flow if there's none yet), then run one agent turn with the given
// tools. This is the one call most product-specific code should need —
// reach for ensureAssistantAuth/runAgent directly only for multi-turn or
// multi-stack scenarios.
export async function runTask(stackUrl: string, task: string, tools: AgentTool[] = []): Promise<string> {
  const tokens = await ensureAssistantAuth(stackUrl);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runAgent(tokens.apiEndpoint, tokens.accessToken, task, tools);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS || !isRetryableA2AError(err)) throw err;
      debugLog("a2a retry", { attempt, error: err instanceof Error ? err.message : String(err) });
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}
