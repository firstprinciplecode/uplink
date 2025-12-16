import { Command } from "commander";
import { apiRequest } from "../http";

export const adminCommand = new Command("admin")
  .description("Admin commands for system management");

// Format date for display
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Status command
adminCommand
  .command("status")
  .description("Show system status and statistics")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      // Check health
      const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
      let health = { status: "unknown" };
      try {
        const fetch = (await import("node-fetch")).default;
        const healthRes = await fetch(`${apiBase}/health`);
        health = await healthRes.json();
      } catch (err) {
        // Health check failed, continue anyway
      }

      // Get stats
      const stats = await apiRequest("GET", "/v1/admin/stats");

      if (opts.json) {
        console.log(JSON.stringify({ health, stats }, null, 2));
      } else {
        console.log("\n📊 System Status\n");
        console.log(`API Health: ${health.status === "ok" ? "✅ OK" : "❌ Error"}`);
        console.log("\n📈 Statistics\n");
        console.log("Tunnels:");
        console.log(`  Active:     ${stats.tunnels.active}`);
        console.log(`  Inactive:   ${stats.tunnels.inactive}`);
        console.log(`  Deleted:    ${stats.tunnels.deleted}`);
        console.log(`  Total:      ${stats.tunnels.total}`);
        console.log(`  Created 24h: ${stats.tunnels.createdLast24h}`);
        console.log("\nDatabases:");
        console.log(`  Ready:      ${stats.databases.ready}`);
        console.log(`  Provisioning: ${stats.databases.provisioning}`);
        console.log(`  Failed:     ${stats.databases.failed}`);
        console.log(`  Deleted:    ${stats.databases.deleted}`);
        console.log(`  Total:      ${stats.databases.total}`);
        console.log(`  Created 24h: ${stats.databases.createdLast24h}`);
        console.log();
      }
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error getting status:", errorMsg);
      process.exit(1);
    }
  });

// Tunnels command
adminCommand
  .command("tunnels")
  .description("List all tunnels")
  .option("--status <status>", "Filter by status (active, inactive, deleted)")
  .option("--limit <limit>", "Limit results", "20")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const query: string[] = [];
      if (opts.status) query.push(`status=${encodeURIComponent(opts.status)}`);
      if (opts.limit) query.push(`limit=${opts.limit}`);
      const queryStr = query.length > 0 ? `?${query.join("&")}` : "";

      const result = await apiRequest("GET", `/v1/admin/tunnels${queryStr}`);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n🔗 Tunnels (showing ${result.count} of ${result.total})\n`);
        if (result.tunnels.length === 0) {
          console.log("No tunnels found.");
        } else {
          console.log(
            "ID".padEnd(40) +
            "Token".padEnd(14) +
            "Port".padEnd(6) +
            "Status".padEnd(10) +
            "Created"
          );
          console.log("-".repeat(90));
          for (const tunnel of result.tunnels) {
            const id = tunnel.id.substring(0, 38);
            const token = tunnel.token.substring(0, 12);
            const port = String(tunnel.target_port || tunnel.targetPort || "-");
            const status = tunnel.status || "unknown";
            const created = formatDate(tunnel.created_at || tunnel.createdAt);
            console.log(
              id.padEnd(40) +
              token.padEnd(14) +
              port.padEnd(6) +
              status.padEnd(10) +
              created
            );
          }
        }
        console.log();
      }
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error listing tunnels:", errorMsg);
      process.exit(1);
    }
  });

// Databases command
adminCommand
  .command("databases")
  .description("List all databases")
  .option("--status <status>", "Filter by status (ready, provisioning, failed, deleted)")
  .option("--limit <limit>", "Limit results", "20")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const query: string[] = [];
      if (opts.status) query.push(`status=${encodeURIComponent(opts.status)}`);
      if (opts.limit) query.push(`limit=${opts.limit}`);
      const queryStr = query.length > 0 ? `?${query.join("&")}` : "";

      const result = await apiRequest("GET", `/v1/admin/databases${queryStr}`);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n🗄️  Databases (showing ${result.count} of ${result.total})\n`);
        if (result.databases.length === 0) {
          console.log("No databases found.");
        } else {
          console.log(
            "ID".padEnd(40) +
            "Name".padEnd(20) +
            "Provider".padEnd(12) +
            "Region".padEnd(15) +
            "Status".padEnd(12) +
            "Created"
          );
          console.log("-".repeat(110));
          for (const db of result.databases) {
            const id = db.id.substring(0, 38);
            const name = (db.name || "-").substring(0, 18);
            const provider = (db.provider || "-").substring(0, 10);
            const region = (db.region || "-").substring(0, 13);
            const status = db.status || "unknown";
            const created = formatDate(db.created_at || db.createdAt);
            console.log(
              id.padEnd(40) +
              name.padEnd(20) +
              provider.padEnd(12) +
              region.padEnd(15) +
              status.padEnd(12) +
              created
            );
          }
        }
        console.log();
      }
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error listing databases:", errorMsg);
      process.exit(1);
    }
  });

