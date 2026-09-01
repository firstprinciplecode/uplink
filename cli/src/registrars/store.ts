import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ProviderId, RegistrarCredentials } from "./types";

export type RegistrarStore = Partial<Record<ProviderId, RegistrarCredentials>>;

function storeDir(): string {
  return join(homedir(), ".uplink");
}

export function registrarStorePath(): string {
  return join(storeDir(), "registrars.json");
}

export function readRegistrarStore(): RegistrarStore {
  const path = registrarStorePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistrarStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeRegistrarStore(store: RegistrarStore): void {
  // 0700 so ~/.uplink is not world-listable if this path creates it first
  // (matches credentials.ts).
  mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
  const path = registrarStorePath();
  writeFileSync(path, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function saveProvider(id: ProviderId, creds: RegistrarCredentials): void {
  const store = readRegistrarStore();
  store[id] = creds;
  writeRegistrarStore(store);
}

export function removeProvider(id: ProviderId): boolean {
  const store = readRegistrarStore();
  if (!store[id]) return false;
  delete store[id];
  writeRegistrarStore(store);
  return true;
}

export function connectedProviders(): ProviderId[] {
  const store = readRegistrarStore();
  return (Object.keys(store) as ProviderId[]).filter((id) => Boolean(store[id]));
}
