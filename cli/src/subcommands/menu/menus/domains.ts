import { isBackInput } from "../io";
import type { SelectOption } from "../inline-tree-select";
import type { MenuChoice } from "../types";
import {
  parseHostedApps,
  runCli,
  runCliCapture,
  runCliResult,
  parseCliJson,
  type HostedApp,
} from "./hosting";
import { listAppDomains, type AppDomainRow } from "../domain-bind";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
  inlineSelect: (
    title: string,
    options: SelectOption[],
    includeBack?: boolean
  ) => Promise<{ index: number; value: string | number | null } | null>;
};

const PROVIDER_OPTIONS: SelectOption[] = [
  { label: "GoDaddy", value: "godaddy" },
  { label: "Cloudflare", value: "cloudflare" },
  { label: "Hostinger", value: "hostinger" },
  { label: "Namecheap", value: "namecheap" },
  { label: "DreamHost", value: "dreamhost" },
  { label: "cPanel hosting (Namecheap shared, Bluehost, HostGator, …)", value: "cpanel" },
];

function cliErrorText(result: { stdout: string; stderr: string }): string {
  const fromJson =
    parseCliJson<{ error?: string }>(result.stdout) || parseCliJson<{ error?: string }>(result.stderr);
  return fromJson?.error || result.stderr || result.stdout || "Command failed";
}

function formatDns(dns?: { type: string; host: string; target: string }): string[] {
  if (!dns) return [];
  return [
    `DNS needed: ${dns.type}  ${dns.host}  →  ${dns.target}`,
    "Propagation can take a few minutes.",
  ];
}

async function pickHostedApp(
  deps: Deps,
  title: string
): Promise<{ kind: "app"; app: HostedApp } | { kind: "back" } | { kind: "empty" }> {
  const output = runCliCapture(["host", "list"]);
  if (!output || output.includes("No apps found")) {
    deps.restoreRawMode();
    return { kind: "empty" };
  }
  const apps = parseHostedApps(output);
  if (apps.length === 0) {
    deps.restoreRawMode();
    return { kind: "empty" };
  }
  if (apps.length === 1) return { kind: "app", app: apps[0] };
  const options: SelectOption[] = apps.map((app) => ({
    label: `${app.name}${app.url ? `  ${app.url}` : ""}`,
    value: app.id,
  }));
  const choice = await deps.inlineSelect(title, options, true);
  if (choice === null) {
    deps.restoreRawMode();
    return { kind: "back" };
  }
  const app = apps.find((item) => item.id === choice.value);
  if (!app) {
    deps.restoreRawMode();
    return { kind: "empty" };
  }
  return { kind: "app", app };
}

function verifyHostname(appId: string, hostname: string): string[] {
  const result = runCliResult(["host", "domains", "verify", "--id", appId, "--hostname", hostname, "--json"]);
  const parsed = parseCliJson<AppDomainRow>(result.stdout);
  if (parsed?.verified) {
    return [`Verified ${hostname}`, `Live at https://${hostname} (certificate may take a first request).`];
  }
  const lines = [`Not verified yet: ${hostname}`];
  if (parsed?.reason) lines.push(parsed.reason);
  lines.push(...formatDns(parsed?.dns));
  return lines;
}

export function buildDomainsMenu(deps: Deps): MenuChoice {
  const { restoreRawMode, promptLine } = deps;

  return {
    label: "Domains",
    subMenu: [
      {
        label: "My domains",
        screen: "my-domains",
      },
      {
        label: "Connect registrar",
        action: async () => {
          const choice = await deps.inlineSelect("Which registrar?", PROVIDER_OPTIONS, true);
          if (choice === null || typeof choice.value !== "string") {
            restoreRawMode();
            return "";
          }
          const provider = choice.value;
          const extraEnv: Record<string, string> = {};
          const args = ["domains", "providers", "connect", provider, "--token-env", "UPLINK_CONNECT_TOKEN"];
          if (provider === "cpanel") {
            const host = (await promptLine("cPanel host (e.g. server341.web-hosting.com, or back): ")).trim();
            if (!host || isBackInput(host)) {
              restoreRawMode();
              return "";
            }
            const user = (await promptLine("cPanel username (or back): ")).trim();
            if (!user || isBackInput(user)) {
              restoreRawMode();
              return "";
            }
            const token = (await promptLine("cPanel API token (Security → Manage API Tokens, or back): ")).trim();
            if (!token || isBackInput(token)) {
              restoreRawMode();
              return "";
            }
            extraEnv.UPLINK_CONNECT_TOKEN = token;
            extraEnv.UPLINK_CONNECT_USER = user;
            args.push("--user-env", "UPLINK_CONNECT_USER", "--host", host);
          } else if (provider === "namecheap") {
            const user = (await promptLine("Namecheap API user (or back): ")).trim();
            if (!user || isBackInput(user)) {
              restoreRawMode();
              return "";
            }
            const key = (await promptLine("Namecheap API key (or back): ")).trim();
            if (!key || isBackInput(key)) {
              restoreRawMode();
              return "";
            }
            extraEnv.UPLINK_CONNECT_TOKEN = key;
            extraEnv.UPLINK_CONNECT_USER = user;
            args.push("--user-env", "UPLINK_CONNECT_USER");
          } else {
            const token = (
              await promptLine(
                `${PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider} API token (or back): `
              )
            ).trim();
            if (!token || isBackInput(token)) {
              restoreRawMode();
              return "";
            }
            extraEnv.UPLINK_CONNECT_TOKEN = token;
          }
          try {
            runCli(args, extraEnv);
            restoreRawMode();
            return `Connected ${provider}.`;
          } catch (error) {
            restoreRawMode();
            return error instanceof Error ? error.message : String(error);
          }
        },
      },
      {
        label: "Find a domain",
        screen: "find-domain",
      },
      {
        label: "Attach to app",
        screen: "attach-app",
      },
      {
        label: "Verify DNS",
        action: async () => {
          try {
            const picked = await pickHostedApp(deps, "Verify a domain on which app?");
            if (picked.kind === "back") return "";
            if (picked.kind === "empty") return "No hosted apps.";
            const rows = listAppDomains(picked.app.id);
            if (rows.length === 0) {
              restoreRawMode();
              return `Nothing attached to ${picked.app.name} yet. Ask an agent to bind a hostname, then verify here.`;
            }
            const pending = rows.filter((row) => !row.verified);
            const pool = pending.length > 0 ? pending : rows;
            const choice = await deps.inlineSelect(
              pending.length > 0 ? "Which hostname still needs DNS?" : "All verified — check again?",
              pool.map((row) => ({
                label: `${row.hostname}  ${row.verified ? "verified" : "pending"}`,
                value: row.hostname,
              })),
              true
            );
            if (choice === null || typeof choice.value !== "string") {
              restoreRawMode();
              return "";
            }
            const lines = verifyHostname(picked.app.id, choice.value);
            restoreRawMode();
            return lines.join("\n");
          } catch (error) {
            restoreRawMode();
            return error instanceof Error ? error.message : String(error);
          }
        },
      },
      {
        label: "List on app",
        action: async () => {
          const picked = await pickHostedApp(deps, "List domains for which app?");
          if (picked.kind === "back") return "";
          if (picked.kind === "empty") return "No hosted apps.";
          const output = runCliCapture(["host", "domains", "list", "--id", picked.app.id]);
          restoreRawMode();
          return `${picked.app.name}\n${output || "No custom domains attached."}`;
        },
      },
      {
        label: "Detach from app",
        action: async () => {
          try {
            const picked = await pickHostedApp(deps, "Detach a domain from which app?");
            if (picked.kind === "back") return "";
            if (picked.kind === "empty") return "No hosted apps.";
            const rows = listAppDomains(picked.app.id);
            if (rows.length === 0) {
              restoreRawMode();
              return `Nothing attached to ${picked.app.name}.`;
            }
            const choice = await deps.inlineSelect(
              `Detach from ${picked.app.name}? Routing for that hostname stops.`,
              rows.map((row) => ({
                label: `${row.hostname}  ${row.verified ? "verified" : "pending"}`,
                value: row.hostname,
              })),
              true
            );
            if (choice === null || typeof choice.value !== "string") {
              restoreRawMode();
              return "";
            }
            runCli(["host", "domains", "remove", "--id", picked.app.id, "--hostname", choice.value]);
            restoreRawMode();
            return `Detached ${choice.value} from ${picked.app.name}.`;
          } catch (error) {
            restoreRawMode();
            return error instanceof Error ? error.message : String(error);
          }
        },
      },
      {
        label: "Help",
        page: [
            "One hub for domains and hosting across registrars and cPanel hosts.",
            "",
            "  My domains  — search inventory, open a name for expiry / RDAP / attached apps",
            "  Connect     — save a registrar or cPanel API token",
            "  Find        — search names (public DNS; m = more TLDs)",
            "  Attach      — pick an app, then copy bind/verify commands",
            "  Verify      — after DNS is pointed, check the edge + TLS",
            "",
            "Custom domains need a paid hosting plan. DNS stays at the registrar.",
            "",
            "CLI:",
            "  uplink domains list --json",
            "  uplink domains search acme --json",
            "  uplink host domains add --id <app> --hostname example.com --json",
            "  uplink host domains verify --id <app> --hostname example.com --json",
          ].join("\n"),
      },
    ],
  };
}
