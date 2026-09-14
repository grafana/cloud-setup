import crypto from "node:crypto";
import { debugLog } from "../debug.js";

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

interface SSEEvent {
  jsonrpc?: string;
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: string };
}

interface PendingCall {
  toolId: string;
  toolName: string;
  inputs: unknown;
}
interface PendingRequest {
  requestId: string;
  chatId: string;
  toolName: string;
}

const CLIENT_TOOLS_EXTENSION = "https://grafana.com/extensions/client-provided-tools/v1";
const REMOTE_TOOL_EXTENSION = "https://grafana.com/extensions/remote-tool-execution/v1";
const AGENT_ID = "grafana_assistant_cli";
const MAX_EVENTS_READ = 500;
const TERMINAL_ERROR_STATES = new Set(["failed", "canceled", "rejected", "auth-required"]);

function buildHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "X-A2A-Extensions": [REMOTE_TOOL_EXTENSION, CLIENT_TOOLS_EXTENSION].join(", "),
    "X-App-Source": "grafana-setup-cli",
  };
}

// Extracts complete SSE events (blank-line-delimited `data: ...` blocks)
// from a mutable text buffer, leaving any trailing incomplete event in
// place for the next chunk. Mirrors k6 Studio's ActiveA2ASession parsing.
function extractSSEEvents(buffer: { text: string }): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = buffer.text.split("\n");
  let dataLines: string[] = [];
  let lastCompleteIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      if (dataLines.length > 0) {
        try {
          events.push(JSON.parse(dataLines.join("\n")) as SSEEvent);
        } catch {
          // skip malformed event
        }
      }
      dataLines = [];
      lastCompleteIndex = i;
      continue;
    }
    if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }

  buffer.text = lastCompleteIndex >= 0 ? lines.slice(lastCompleteIndex + 1).join("\n") : buffer.text;
  return events;
}

// Runs one A2A "message/stream" turn to completion over a single
// long-lived SSE connection, executing any tools the agent calls locally
// via the Remote Tool Execution extension (tool results are POSTed back
// while the same stream stays open — no new request per turn, mirroring
// k6 Studio's ActiveA2ASession/GrafanaAssistantLanguageModel). Returns the
// concatenated text of every step.message artifact the agent produced.
export async function runAgent(
  apiEndpoint: string,
  accessToken: string,
  userText: string,
  tools: AgentTool[] = []
): Promise<string> {
  const baseUrl = `${apiEndpoint}/api/cli/v1/a2a`;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  debugLog("agent task", userText);

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/stream",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: crypto.randomUUID(),
        parts: [{ kind: "text", text: userText }],
      },
      ...(tools.length > 0
        ? {
            metadata: {
              [CLIENT_TOOLS_EXTENSION]: {
                tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
              },
            },
          }
        : {}),
    },
  };

  const res = await fetch(`${baseUrl}/agents/${AGENT_ID}`, {
    method: "POST",
    headers: buildHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`A2A request failed (${res.status}): ${await res.text().catch(() => "unknown error")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: "" };

  const answerParts: string[] = [];
  const unmatchedCalls: PendingCall[] = [];
  const unmatchedRequests: PendingRequest[] = [];

  async function dispatchMatchedTools(): Promise<void> {
    for (let i = unmatchedCalls.length - 1; i >= 0; i--) {
      const call = unmatchedCalls[i]!;
      const reqIdx = unmatchedRequests.findIndex((r) => r.toolName === call.toolName);
      if (reqIdx === -1) continue;

      const req = unmatchedRequests.splice(reqIdx, 1)[0]!;
      unmatchedCalls.splice(i, 1);

      let payload: Record<string, unknown>;
      try {
        const input = typeof call.inputs === "string" ? JSON.parse(call.inputs) : call.inputs ?? {};
        debugLog(`tool call: ${call.toolName}`, input);
        const tool = toolsByName.get(call.toolName);
        if (!tool) throw new Error(`no local tool registered for "${call.toolName}"`);
        const result = await tool.execute(input as Record<string, unknown>);
        debugLog(`tool result: ${call.toolName}`, result ?? null);
        payload = { requestId: req.requestId, chatId: req.chatId, success: true, result: result ?? null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(`tool error: ${call.toolName}`, message);
        payload = { requestId: req.requestId, chatId: req.chatId, success: false, error: message };
      }

      await fetch(`${baseUrl}/remote-tool-response`, {
        method: "POST",
        headers: buildHeaders(accessToken),
        body: JSON.stringify(payload),
      });
    }
  }

  for (let read = 0; read < MAX_EVENTS_READ; read++) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer.text += decoder.decode(value, { stream: true });

    for (const event of extractSSEEvents(buffer)) {
      if (event.error) {
        throw new Error(`A2A error (${event.error.code}): ${event.error.message}`);
      }
      const result = event.result;
      if (!result) continue;

      if (result.type === "REMOTE_TOOL_REQUEST") {
        const data = result.data as { requestId: string; chatId: string; toolName: string };
        unmatchedRequests.push({ requestId: data.requestId, chatId: data.chatId, toolName: data.toolName });
        await dispatchMatchedTools();
        continue;
      }

      if (result.kind === "status-update") {
        const state = (result.status as { state: string }).state;
        if (state === "completed") {
          const answer = answerParts.join("\n");
          debugLog("agent final response", answer);
          return answer;
        }
        if (TERMINAL_ERROR_STATES.has(state)) throw new Error(`A2A task ${state}`);
        continue;
      }

      if (result.kind === "artifact-update") {
        const artifact = result.artifact as { name: string; parts: Array<Record<string, unknown>> };

        if (artifact.name === "step.toolCall") {
          const dataPart = artifact.parts.find((p) => p.kind === "data");
          const data = dataPart?.data as { toolId?: string; toolName?: string; inputs?: unknown } | undefined;
          if (data?.toolId && data?.toolName) {
            unmatchedCalls.push({ toolId: data.toolId, toolName: data.toolName, inputs: data.inputs });
            await dispatchMatchedTools();
          }
        } else if (artifact.name === "step.message") {
          for (const part of artifact.parts) {
            if (part.kind === "text" && typeof part.text === "string") answerParts.push(part.text);
          }
        }
      }
    }
  }

  throw new Error(`A2A task did not complete within ${MAX_EVENTS_READ} stream reads`);
}
