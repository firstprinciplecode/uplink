import {
  parseHostedApps,
  runCliCapture,
  runCliResult,
  parseCliJson,
  type HostedApp,
} from "./menus/hosting";

export type InventoryItem = {
  domain: string;
  provider: string;
  status?: string;
  expiresAt?: string;
  registration?: { registered?: boolean | null; expiresAt?: string; detail?: string };
};
export type AppDomainRow = {
  hostname: string;
  verified?: boolean;
  dns?: { type: string; host: string; target: string };
  reason?: string;
  error?: string;
};

export type AttachAppInfo = {
  app: HostedApp;
  domains: AppDomainRow[];
};

export type AttachSnapshot = {
  apps: AttachAppInfo[];
  inventory: InventoryItem[];
};

function cliErrorText(result: { stdout: string; stderr: string }): string {
  const fromJson =
    parseCliJson<{ error?: string }>(result.stdout) || parseCliJson<{ error?: string }>(result.stderr);
  return fromJson?.error || result.stderr || result.stdout || "Command failed";
}

export function listInventory(preserveRawMode = false): InventoryItem[] {
  const result = runCliResult(["domains", "list", "--json"], undefined, preserveRawMode);
  if (result.status !== 0) {
    const message = cliErrorText(result);
    if (/no domains|not connected/i.test(message)) return [];
    throw new Error(message);
  }
  const parsed = parseCliJson<{ domains?: InventoryItem[] }>(result.stdout);
  return parsed?.domains ?? [];
}

export function listAppDomains(appId: string, preserveRawMode = false): AppDomainRow[] {
  const result = runCliResult(["host", "domains", "list", "--id", appId, "--json"], undefined, preserveRawMode);
  if (result.status !== 0) throw new Error(cliErrorText(result));
  return parseCliJson<{ domains?: AppDomainRow[] }>(result.stdout)?.domains ?? [];
}

export function loadApps(preserveRawMode = false): HostedApp[] {
  const output = runCliCapture(["host", "list"], undefined, preserveRawMode);
  if (!output || output.includes("No apps found")) return [];
  return parseHostedApps(output);
}

export function loadAttachSnapshot(): AttachSnapshot {
  let apps: HostedApp[] = [];
  try {
    apps = loadApps(true);
  } catch {
    apps = [];
  }
  let inventory: InventoryItem[] = [];
  try {
    inventory = listInventory(true);
  } catch {
    inventory = [];
  }
  return {
    inventory,
    apps: apps.map((app) => {
      let domains: AppDomainRow[] = [];
      try {
        domains = listAppDomains(app.id, true);
      } catch {
        domains = [];
      }
      return { app, domains };
    }),
  };
}

export function sampleHostname(inventory: InventoryItem[]): string {
  return inventory[0]?.domain ?? "example.com";
}

export function bindCommands(appId: string, hostname: string): { add: string; verify: string } {
  return {
    add: `uplink host domains add --id ${appId} --hostname ${hostname} --json`,
    verify: `uplink host domains verify --id ${appId} --hostname ${hostname} --json`,
  };
}

export type DomainCheck = {
  domain: string;
  provider?: string;
  status?: string;
  buyable?: boolean | null;
  detail?: string;
  priceUsd?: number;
  error?: string;
};

export function checkInventoryDomain(domain: string): DomainCheck {
  const result = runCliResult(["domains", "check", domain, "--json"], undefined, true);
  const parsed = parseCliJson<DomainCheck>(result.stdout) || parseCliJson<DomainCheck>(result.stderr);
  if (!parsed) {
    return { domain, error: cliErrorText(result) };
  }
  return parsed;
}
