import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";

type AppDomain = {
  id: string;
  hostname: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
  dns?: { type: string; host: string; target: string };
};
type AppDomainList = { domains: AppDomain[] };

async function findDomainByHostname(appId: string, hostname: string): Promise<AppDomain | null> {
  const result = (await apiRequest("GET", `/v1/apps/${appId}/domains`)) as AppDomainList;
  const clean = hostname.trim().toLowerCase();
  return result.domains?.find((d) => d.hostname === clean) ?? null;
}

function printDomain(domain: AppDomain): void {
  const status = domain.verified ? "verified" : "pending verification";
  console.log(`- ${domain.hostname} (${status})`);
  if (domain.dns) {
    console.log(`  DNS needed: ${domain.dns.type} ${domain.dns.host} -> ${domain.dns.target}`);
  }
}

/** The verify endpoint responds 409 with a reason while DNS doesn't point at the edge. */
function extractVerifyFailure(error: unknown): { reason?: string; dns?: AppDomain["dns"] } | null {
  if (!(error instanceof Error)) return null;
  try {
    const parsed = JSON.parse(error.message) as { reason?: string; dns?: AppDomain["dns"] };
    return parsed && (parsed.reason || parsed.dns) ? parsed : null;
  } catch {
    return null;
  }
}

export const domainsCommand = new Command("domains").description(
  "Manage custom domains for hosted apps"
);

domainsCommand
  .command("list")
  .description("List custom domains attached to an app")
  .requiredOption("--id <id>", "App id (app_...)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = (await apiRequest("GET", `/v1/apps/${opts.id}/domains`)) as AppDomainList;
      if (opts.json) {
        printJson(result);
        return;
      }
      if (!result.domains || result.domains.length === 0) {
        console.log("No custom domains attached.");
        return;
      }
      console.log("Custom domains:");
      for (const domain of result.domains) printDomain(domain);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("add")
  .description("Attach a custom domain to an app")
  .requiredOption("--id <id>", "App id (app_...)")
  .requiredOption("--hostname <hostname>", "Domain to attach (e.g. example.com)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const domain = (await apiRequest("POST", `/v1/apps/${opts.id}/domains`, {
        hostname: opts.hostname,
      })) as AppDomain;
      if (opts.json) {
        printJson(domain);
        return;
      }
      console.log(`Attached ${domain.hostname} (pending verification)`);
      if (domain.dns) {
        console.log(`  1. At your registrar: ${domain.dns.type} ${domain.dns.host} -> ${domain.dns.target}`);
      }
      console.log(`  2. Then run: uplink host domains verify --id ${opts.id} --hostname ${domain.hostname}`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("verify")
  .description("Verify a domain's DNS points at the hosting edge (enables routing + TLS)")
  .requiredOption("--id <id>", "App id (app_...)")
  .requiredOption("--hostname <hostname>", "Domain to verify")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const domain = await findDomainByHostname(opts.id, opts.hostname);
      if (!domain) throw new Error(`Domain ${opts.hostname} is not attached to app ${opts.id}`);

      try {
        const verified = (await apiRequest(
          "POST",
          `/v1/apps/${opts.id}/domains/${domain.id}/verify`
        )) as AppDomain;
        if (opts.json) printJson(verified);
        else {
          console.log(`Verified ${verified.hostname}`);
          console.log(`  Live at https://${verified.hostname} (cert issues on first request)`);
        }
      } catch (error) {
        const failure = extractVerifyFailure(error);
        if (!failure) throw error;
        if (opts.json) {
          printJson({ hostname: domain.hostname, verified: false, ...failure });
          return;
        }
        console.log(`Not verified yet: ${failure.reason || "DNS does not point at the edge"}`);
        if (failure.dns) {
          console.log(`  DNS needed: ${failure.dns.type} ${failure.dns.host} -> ${failure.dns.target}`);
        }
        console.log("  DNS changes can take a few minutes to propagate; try again shortly.");
        process.exitCode = 1;
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("remove")
  .description("Detach a custom domain from an app")
  .requiredOption("--id <id>", "App id (app_...)")
  .requiredOption("--hostname <hostname>", "Domain to detach")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const domain = await findDomainByHostname(opts.id, opts.hostname);
      if (!domain) throw new Error(`Domain ${opts.hostname} is not attached to app ${opts.id}`);
      const result = await apiRequest("DELETE", `/v1/apps/${opts.id}/domains/${domain.id}`);
      if (opts.json) printJson(result);
      else console.log(`Detached ${opts.hostname}`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
