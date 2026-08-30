import { Command } from "commander";
import { spawn } from "child_process";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Non-fatal: the URL is printed either way.
  }
}

export const upgradeCommand = new Command("upgrade")
  .description("Upgrade to Uplink Pro — unlimited apps in 1 GB, always-on, custom domains, aliases")
  .option("--yearly", "Yearly billing (2 months free)", false)
  .option("--json", "Output JSON (prints the checkout URL, does not open a browser)", false)
  .action(async (opts) => {
    try {
      const interval = opts.yearly ? "year" : "month";
      const result = await apiRequest("POST", "/v1/billing/checkout", { interval });
      if (opts.json) {
        printJson({ url: result.url, interval: result.interval });
        return;
      }
      console.log("");
      console.log("Uplink Pro — complete your upgrade in the browser:");
      console.log("");
      console.log(`  ${result.url}`);
      console.log("");
      openInBrowser(result.url);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

export const billingCommand = new Command("billing")
  .description("Manage your subscription (opens the Stripe billing portal)")
  .option("--json", "Output JSON (prints the portal URL, does not open a browser)", false)
  .action(async (opts) => {
    try {
      const result = await apiRequest("POST", "/v1/billing/portal");
      if (opts.json) {
        printJson({ url: result.url });
        return;
      }
      console.log("");
      console.log("Manage your subscription here:");
      console.log("");
      console.log(`  ${result.url}`);
      console.log("");
      openInBrowser(result.url);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
