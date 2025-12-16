import { Command } from "commander";
import { apiRequest } from "../http";

export const dbCommand = new Command("db").description("Manage databases");

dbCommand
  .command("create")
  .description("Create a new database")
  .requiredOption("--name <name>", "Database name")
  .requiredOption("--project <project>", "Project name")
  .option("--provider <provider>", "Provider", "neon")
  .option("--region <region>", "Region", "eu-central-1")
  .option("--plan <plan>", "Plan", "dev")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const body = {
      name: opts.name,
      project: opts.project,
      provider: opts.provider,
      region: opts.region,
      plan: opts.plan,
    };

    const result = await apiRequest("POST", "/v1/dbs", body);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Created DB ${result.name} (${result.id}) in ${result.region}`);
    }
  });

dbCommand
  .command("list")
  .description("List databases")
  .option("--project <project>", "Project name")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const query = opts.project ? `?project=${encodeURIComponent(opts.project)}` : "";
    const result = await apiRequest("GET", `/v1/dbs${query}`);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const db of result.items) {
        console.log(
          `${db.id}  ${db.name}  ${db.region}  ${db.status}  ready=${db.ready}`
        );
      }
    }
  });

dbCommand
  .command("info")
  .description("Get details for a database")
  .requiredOption("--id <id>", "Database id")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const result = await apiRequest("GET", `/v1/dbs/${opts.id}`);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`DB ${result.name} (${result.id})`);
      console.log(`  region: ${result.region}`);
      console.log(`  status: ${result.status}`);
      console.log(`  engine: ${result.engine} ${result.version}`);
    }
  });

dbCommand
  .command("delete")
  .description("Delete a database")
  .requiredOption("--id <id>", "Database id")
  .option("--yes", "Confirm deletion", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    if (!opts.yes) {
      throw new Error("Refusing to delete without --yes");
    }
    const result = await apiRequest("DELETE", `/v1/dbs/${opts.id}`);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Deleted DB ${result.id}`);
    }
  });

dbCommand
  .command("link")
  .description("Link a DB to a service via env var")
  .requiredOption("--db-id <id>", "Database id")
  .requiredOption("--service <service>", "Service name")
  .requiredOption("--env-var <envVar>", "Environment variable name")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const body = {
      service: opts.service,
      envVar: opts["env-var"],
    };

    const result = await apiRequest(
      "POST",
      `/v1/dbs/${opts["db-id"]}/link-service`,
      body
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `Linked DB ${result.dbId} to service ${result.service} as ${result.envVar}`
      );
    }
  });




