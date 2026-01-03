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

// Tokens command group
const tokensCommand = adminCommand
  .command("tokens")
  .description("Manage API tokens (mint/list/revoke)");

tokensCommand
  .command("create")
  .description("Mint a new token (returned once)")
  .requiredOption("--role <role>", "Role: user|admin", "user")
  .option("--label <label>", "Optional label (e.g. customer name)")
  .option("--expires-days <days>", "Optional expiry in days (integer)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const role = String(opts.role || "user");
      const label = opts.label ? String(opts.label) : undefined;
      const expiresInDays = opts.expiresDays ? Number(opts.expiresDays) : undefined;

      const result = await apiRequest("POST", "/v1/admin/tokens", {
        role,
        label,
        expiresInDays: Number.isFinite(expiresInDays as any) ? expiresInDays : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("\n🔑 Token created\n");
      console.log(`Role:      ${result.role}`);
      console.log(`User ID:    ${result.userId}`);
      console.log(`Token ID:   ${result.id}`);
      console.log(`Prefix:     ${result.tokenPrefix}`);
      if (result.label) console.log(`Label:      ${result.label}`);
      if (result.expiresAt) console.log(`Expires:    ${result.expiresAt}`);
      console.log("\nIMPORTANT: This token is shown only once. Store it securely.\n");
      console.log(result.token);
      console.log();
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error creating token:", errorMsg);
      process.exit(1);
    }
  });

tokensCommand
  .command("list")
  .description("List tokens (no raw token values)")
  .option("--limit <limit>", "Limit results", "50")
  .option("--offset <offset>", "Offset", "0")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const limit = Number(opts.limit) || 50;
      const offset = Number(opts.offset) || 0;
      const result = await apiRequest(
        "GET",
        `/v1/admin/tokens?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(
          String(offset)
        )}`
      );

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\n🪪 Tokens (showing ${result.count} of ${result.total})\n`);
      if (!result.tokens || result.tokens.length === 0) {
        console.log("No tokens found.");
        return;
      }

      console.log(
        "ID".padEnd(18) +
          "Role".padEnd(8) +
          "Prefix".padEnd(10) +
          "User ID".padEnd(40) +
          "Created By".padEnd(40) +
          "Status".padEnd(12) +
          "Created"
      );
      console.log("-".repeat(140));

      for (const t of result.tokens) {
        const id = String(t.id || "").slice(0, 16);
        const role = String(t.role || "-").slice(0, 6);
        const prefix = String(t.token_prefix || t.tokenPrefix || "-").slice(0, 8);
        const userId = String(t.user_id || t.userId || "-").slice(0, 38);
        const createdBy = String(t.created_by_user_id || t.createdByUserId || "-").slice(0, 38);
        const status = t.revoked_at || t.revokedAt ? "revoked" : "active";
        const created = formatDate(t.created_at || t.createdAt || "");
        console.log(
          id.padEnd(18) +
            role.padEnd(8) +
            prefix.padEnd(10) +
            userId.padEnd(40) +
            createdBy.padEnd(40) +
            status.padEnd(12) +
            created
        );
      }
      console.log();
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error listing tokens:", errorMsg);
      process.exit(1);
    }
  });

tokensCommand
  .command("revoke")
  .description("Revoke a token (prefer by id)")
  .option("--id <id>", "Token id (recommended)")
  .option("--token <token>", "Raw token (avoid: may end up in shell history)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const id = opts.id ? String(opts.id) : "";
      const token = opts.token ? String(opts.token) : "";
      if (!id && !token) {
        console.error("Provide --id or --token");
        process.exit(1);
      }

      const result = await apiRequest("POST", "/v1/admin/tokens/revoke", {
        id: id || undefined,
        token: token || undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✅ Revoked token${id ? ` ${id}` : ""} at ${result.revokedAt || ""}`);
      }
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error revoking token:", errorMsg);
      process.exit(1);
    }
  });

// Cleanup command
adminCommand
  .command("cleanup")
  .description("Cleanup old data")
  .option("--dev-user-tunnels", "Clean up tunnels owned by dev-user", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      if (opts.devUserTunnels) {
        const result = await apiRequest("POST", "/v1/admin/cleanup/dev-user-tunnels", {});

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✅ ${result.message || `Cleaned up ${result.deleted || 0} dev-user tunnels`}`);
        }
      } else {
        console.error("Specify what to cleanup: --dev-user-tunnels");
        process.exit(1);
      }
    } catch (error: any) {
      const errorMsg = error.message || error.toString() || JSON.stringify(error);
      console.error("Error during cleanup:", errorMsg);
      process.exit(1);
    }
  });

