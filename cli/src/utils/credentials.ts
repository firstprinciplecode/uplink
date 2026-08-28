import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type StoredCredentials = {
  token: string;
  userId?: string;
  email?: string;
  accountType?: "guest" | "verified";
  apiBase?: string;
  updatedAt?: string;
};

function credentialsDir(): string {
  return join(homedir(), ".uplink");
}

export function credentialsPath(): string {
  return join(credentialsDir(), "credentials");
}

export function readStoredCredentials(): StoredCredentials | null {
  try {
    const path = credentialsPath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as StoredCredentials;
    if (!parsed?.token || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredCredentials(creds: StoredCredentials): string {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const path = credentialsPath();
  const body: StoredCredentials = {
    token: creds.token,
    userId: creds.userId,
    email: creds.email,
    accountType: creds.accountType,
    apiBase: creds.apiBase,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return path;
}
