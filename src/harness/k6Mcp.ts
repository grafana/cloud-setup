import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface K6McpClient {
  validateScript(script: string): Promise<{ valid: boolean; errors?: string }>;
  close(): Promise<void>;
}

// One client per playwrightCandidatesFor call — spawns `k6 x mcp` as a
// child process over stdio and speaks MCP to it via the official SDK.
// Callers must have already confirmed isK6McpSupported() (src/k6.ts);
// this doesn't re-check, since spawning a process that turns out not to
// support `x mcp` would just fail the handshake anyway.
export async function connectK6Mcp(): Promise<K6McpClient> {
  const transport = new StdioClientTransport({ command: "k6", args: ["x", "mcp"], stderr: "ignore" });
  const client = new Client({ name: "setup-cli", version: "0.1.0" });
  await client.connect(transport);

  return {
    async validateScript(script: string) {
      try {
        const result = await client.callTool({ name: "validate_script", arguments: { script } });
        const content = "content" in result && Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((entry) => (entry.type === "text" ? entry.text : ""))
          .filter((entry) => entry.length > 0)
          .join("\n");
        const isError = "isError" in result && result.isError === true;
        if (isError) return { valid: false, errors: text || "validation failed" };
        return { valid: true };
      } catch {
        // Fail open — an unreachable/broken validator must never itself
        // cause a candidate to be dropped; validation is a nice-to-have
        // on top of a nice-to-have.
        return { valid: true };
      }
    },
    async close() {
      await client.close();
    },
  };
}
