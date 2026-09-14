import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface StoredCredentials {
  baseUrl: string;
  token: string;
  stackUrl: string;
  email?: string;
}

function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "synthetics", "credentials.json");
}

export async function readCredentials(): Promise<StoredCredentials | undefined> {
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeCredentials(creds: StoredCredentials): Promise<void> {
  const file = credentialsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
