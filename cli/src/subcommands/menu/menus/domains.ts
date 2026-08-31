import type { SelectOption } from "../inline-tree-select";
import type { MenuChoice } from "../types";
import { buildFindDomainAction } from "./domain-check";
import { parseHostedApps, runCli, runCliCapture } from "./hosting";

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

async function pickHostedApp(
  deps: Deps,
  title: string
): Promise<{ name: string; id: string; url?: string } | null> {
  const output = runCliCapture(["host", "list"]);
  if (!output || output.includes("No apps found")) {
    deps.restoreRawMode();
    return null;
  }
  const apps = parseHostedApps(output);
  if (apps.length === 0) {
    deps.restoreRawMode();
    return null;
  }
  const options: SelectOption[] = apps.map((app) => ({
    label: `${app.name}${app.url ? `  ${app.url}` : ""}`,
    value: app.id,
  }));
  const choice = await deps.inlineSelect(title, options, true);
  if (choice === null) {
    deps.restoreRawMode();
    return null;
  }
  return apps.find((app) => app.id === choice.value) ?? null;
}

export function buildDomainsMenu(deps: Deps): MenuChoice {
  const { restoreRawMode, promptLine } = deps;

  return {
    label: "Domains",
    subMenu: [
      {
        label: "My domains",
        action: async () => {
          try {
            // --verify resolves registration for zone/hosted entries; results
            // are cached for a day, so only the first open is slow.
            const output = runCliCapture(["domains", "list", "--verify"]);
            restoreRawMode();
            return output || "No domains. Connect a registrar first.";
          } catch (error) {
            restoreRawMode();
            return error instanceof Error ? error.message : String(error);
          }
        },
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
            if (!host || host === "back") {
              restoreRawMode();
              return "";
            }
            const user = (await promptLine("cPanel username (or back): ")).trim();
            if (!user || user === "back") {
              restoreRawMode();
              return "";
            }
            const token = (await promptLine("cPanel API token (Security → Manage API Tokens, or back): ")).trim();
            if (!token || token === "back") {
              restoreRawMode();
              return "";
            }
            extraEnv.UPLINK_CONNECT_TOKEN = token;
            extraEnv.UPLINK_CONNECT_USER = user;
            args.push("--user-env", "UPLINK_CONNECT_USER", "--host", host);
          } else if (provider === "namecheap") {
            const user = (await promptLine("Namecheap API user (or back): ")).trim();
            if (!user || user === "back") {
              restoreRawMode();
              return "";
            }
            const key = (await promptLine("Namecheap API key (or back): ")).trim();
            if (!key || key === "back") {
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
            if (!token || token === "back") {
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
        action: buildFindDomainAction(deps),
      },
      {
        label: "Attach to app",
        action: async () => {
          const app = await pickHostedApp(deps, "Attach domain to which app?");
          if (!app) return "No hosted apps. Deploy one under Host first.";
          const hostname = (await promptLine("Hostname (e.g. example.com, or back): ")).trim().toLowerCase();
          if (!hostname || hostname === "back") {
            restoreRawMode();
            return "";
          }
          runCli(["host", "domains", "add", "--id", app.id, "--hostname", hostname]);
          restoreRawMode();
          return `Attached ${hostname} to ${app.name}. Point DNS, then Verify.`;
        },
      },
      {
        label: "Verify DNS",
        action: async () => {
          const app = await pickHostedApp(deps, "Verify a domain on which app?");
          if (!app) return "No hosted apps.";
          const hostname = (await promptLine("Hostname to verify (or back): ")).trim().toLowerCase();
          if (!hostname || hostname === "back") {
            restoreRawMode();
            return "";
          }
          runCli(["host", "domains", "verify", "--id", app.id, "--hostname", hostname]);
          restoreRawMode();
          return `Checked ${hostname} on ${app.name}.`;
        },
      },
      {
        label: "List on app",
        action: async () => {
          const app = await pickHostedApp(deps, "List domains for which app?");
          if (!app) return "No hosted apps.";
          const output = runCliCapture(["host", "domains", "list", "--id", app.id]);
          restoreRawMode();
          return `${app.name}\n${output || "No custom domains attached."}`;
        },
      },
      {
        label: "Detach from app",
        action: async () => {
          const app = await pickHostedApp(deps, "Detach a domain from which app?");
          if (!app) return "No hosted apps.";
          const hostname = (await promptLine("Hostname to detach (or back): ")).trim().toLowerCase();
          if (!hostname || hostname === "back") {
            restoreRawMode();
            return "";
          }
          runCli(["host", "domains", "remove", "--id", app.id, "--hostname", hostname]);
          restoreRawMode();
          return `Detached ${hostname} from ${app.name}.`;
        },
      },
      {
        label: "Help",
        action: async () => {
          return [
            "One hub for domains and hosting spread across providers: registrars and cPanel hosts in a single inventory.",
            "",
            "  My domains  — inventory from GoDaddy / Cloudflare / Hostinger / Namecheap / DreamHost / any cPanel host",
            "  Connect     — save a registrar token or cPanel API token (same as the CLI)",
            "  Find        — search names (public DNS; m = more TLDs; connect a registrar for price)",
            "  Attach      — bind a hostname to a hosted app",
            "  Verify      — check DNS points at the hosting edge, then TLS",
            "",
            "CLI (agents):",
            "  uplink domains providers connect godaddy --token-env GODADDY_PAT --json",
            "  uplink domains list --json",
            "  uplink domains search acme --json",
            "  uplink domains check example.com --json",
            "  uplink host domains add --id <app> --hostname example.com --json",
          ].join("\n");
        },
      },
    ],
  };
}
