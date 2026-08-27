import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";

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
    try {
      const body = {
        name: opts.name,
        project: opts.project,
        provider: opts.provider,
        region: opts.region,
        plan: opts.plan,
      };

      const result = await apiRequest("POST", "/v1/dbs", body);
      if (opts.json) printJson(result);
      else console.log(`Created DB ${result.name} (${result.id}) in ${result.region}`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

dbCommand
  .command("list")
  .description("List databases")
  .option("--project <project>", "Project name")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const query = opts.project ? `?project=${encodeURIComponent(opts.project)}` : "";
      const result = await apiRequest("GET", `/v1/dbs${query}`);
      if (opts.json) {
        printJson(result);
      } else {
        for (const db of result.items || []) {
          console.log(
            `${db.id}  ${db.name}  ${db.region}  ${db.status}  ready=${db.ready}`
          );
        }
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

dbCommand
  .command("info")
  .description("Get details for a database")
  .requiredOption("--id <id>", "Database id")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = await apiRequest("GET", `/v1/dbs/${opts.id}`);
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`DB ${result.name} (${result.id})`);
        console.log(`  region: ${result.region}`);
        console.log(`  status: ${result.status}`);
        console.log(`  engine: ${result.engine} ${result.version}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

dbCommand
  .command("delete")
  .description("Delete a database")
  .requiredOption("--id <id>", "Database id")
  .option("--yes", "Confirm deletion", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      if (!opts.yes) {
        throw new Error("Refusing to delete without --yes");
      }
      const result = await apiRequest("DELETE", `/v1/dbs/${opts.id}`);
      if (opts.json) printJson(result);
      else console.log(`Deleted DB ${result.id}`);
    } catch (error) {
      handleError(error, { json: opts.json });
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
    try {
      const body = {
        service: opts.service,
        envVar: opts.envVar,
      };

      const result = await apiRequest("POST", `/v1/dbs/${opts.dbId}/link-service`, body);

      if (opts.json) {
        printJson(result);
      } else {
        console.log(
          `Linked DB ${result.dbId} to service ${result.service} as ${result.envVar}`
        );
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
