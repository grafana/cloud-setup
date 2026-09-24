import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SKILL_SOURCE = "grafana/skills";
const SKILL_NAME = "synthetic-monitoring-checks";

export interface SkillStatus {
  installed: boolean;
  agents: string[];
  // Single shared folder every detected agent reads the skill from (e.g.
  // .agents/skills/synthetic-monitoring-checks) — not a per-agent path.
  path?: string;
}

async function listSkills(): Promise<{ name?: string; agents?: string[]; path?: string }[]> {
  const { stdout } = await execFileAsync("npx", ["--yes", "skills", "list", "--json"], { timeout: 20000 });
  return JSON.parse(stdout) as { name?: string; agents?: string[]; path?: string }[];
}

export async function getSkillStatus(): Promise<SkillStatus> {
  try {
    const installed = await listSkills();
    const match = installed.find((s) => s.name === SKILL_NAME);
    return { installed: Boolean(match), agents: match?.agents ?? [], path: match?.path };
  } catch {
    return { installed: false, agents: [] };
  }
}

// Fully automatic — lets `skills add` auto-detect which agents are present
// rather than asking the user to pick. Returns the resulting status, read
// back from `skills list` (rather than assumed) so the caller can show real
// data.
export async function installSkill(): Promise<SkillStatus> {
  await execFileAsync("npx", ["--yes", "skills", "add", SKILL_SOURCE, "--skill", SKILL_NAME, "-y"], {
    timeout: 120000,
  });
  return getSkillStatus();
}
