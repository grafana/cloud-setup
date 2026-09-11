import { ensureAssistantAuth } from "./auth.js";
import { runAgent, type AgentTool } from "./a2a.js";

export { ensureAssistantAuth } from "./auth.js";
export { runAgent, type AgentTool } from "./a2a.js";
export { fileTools, fileToolsWithWrite } from "./tools.js";
export { browserTools, type BrowserToolOptions } from "./browserTool.js";

// Convenience wrapper for the common case: authenticate against the given
// stack (reusing/refreshing a stored token, or running the interactive
// OAuth flow if there's none yet), then run one agent turn with the given
// tools. This is the one call most product-specific code should need —
// reach for ensureAssistantAuth/runAgent directly only for multi-turn or
// multi-stack scenarios.
export async function runTask(stackUrl: string, task: string, tools: AgentTool[] = []): Promise<string> {
  const tokens = await ensureAssistantAuth(stackUrl);
  return runAgent(tokens.apiEndpoint, tokens.accessToken, task, tools);
}
