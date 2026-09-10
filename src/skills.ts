import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SKILL_SOURCE = "grafana/skills";
const SKILL_NAME = "synthetic-monitoring-checks";

export interface SkillStatus {
  installed: boolean;
  agents: string[];
}

async function listSkills(): Promise<{ name?: string; agents?: string[] }[]> {
  const { stdout } = await execFileAsync("npx", ["--yes", "skills", "list", "--json"], { timeout: 20000 });
  return JSON.parse(stdout) as { name?: string; agents?: string[] }[];
}

export async function getSkillStatus(): Promise<SkillStatus> {
  try {
    const installed = await listSkills();
    const match = installed.find((s) => s.name === SKILL_NAME);
    return { installed: Boolean(match), agents: match?.agents ?? [] };
  } catch {
    return { installed: false, agents: [] };
  }
}

// Fully automatic — lets `skills add` auto-detect which agents are present
// rather than asking the user to pick. Returns the agents it's now
// configured for, read back from `skills list` (rather than assumed) so the
// caller can show real data.
export async function installSkill(): Promise<string[]> {
  await execFileAsync("npx", ["--yes", "skills", "add", SKILL_SOURCE, "--skill", SKILL_NAME, "-y"], {
    timeout: 120000,
  });
  const status = await getSkillStatus();
  return status.agents;
}
