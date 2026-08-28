import { Command } from "commander";
import { createInterface } from "readline";
import { handleError, printJson } from "../utils/machine";
import { formatTokenForEnv, getResolvedApiBase } from "../utils/api-base";
import { isEmail, normalizeEmail, persistLogin, requestLoginCode, verifyLoginCode } from "../utils/login-flow";

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export const loginCommand = new Command("login")
  .description("Continue with email to unlock persistent features")
  .option("--email <email>", "Email to send the login code to")
  .option("--code <code>", "6-digit code from email (completes login)")
  .option("--no-save", "Do not write ~/.uplink/credentials")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const json = Boolean(opts.json);
      let email = opts.email ? normalizeEmail(opts.email) : "";
      if (!email) {
        if (json) {
          console.error("Provide --email. To finish login, also pass --code.");
          process.exit(2);
        }
        email = normalizeEmail(await prompt("Email: "));
      }
      if (!isEmail(email)) {
        console.error("Invalid email.");
        process.exit(2);
      }

      const codeOpt = opts.code ? String(opts.code).trim() : "";

      if (!codeOpt) {
        await requestLoginCode(email);
        if (json) {
          printJson({ ok: true, email, message: "OTP sent. Run again with --email and --code." });
          return;
        }
        console.log(`Code sent to ${email}.`);
        opts.code = (await prompt("Code: ")).trim();
      }

      const code = String(opts.code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        console.error("Code must be 6 digits.");
        process.exit(2);
      }

      const result = await verifyLoginCode(email, code);
      const apiBase = getResolvedApiBase();
      const save = opts.save !== false;
      let savedTo: string | null = null;
      if (save) {
        savedTo = persistLogin(result, email);
      }

      if (json) {
        printJson({ ...result, email, savedTo });
        return;
      }

      const tokenExport = formatTokenForEnv(result.token, apiBase);
      console.log("Logged in.");
      console.log("");
      console.log(`  Email:    ${email}`);
      console.log(`  User ID:  ${result.userId}`);
      console.log(`  Token:    ${result.token}`);
      if (savedTo) console.log(`  Saved:    ${savedTo}`);
      console.log("");
      if (!savedTo) {
        console.log("To use this token:");
        console.log(`  export AGENTCLOUD_TOKEN="${tokenExport}"`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
