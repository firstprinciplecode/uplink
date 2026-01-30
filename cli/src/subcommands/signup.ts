import { Command } from "commander";
import { printJson, handleError } from "../utils/machine";
import { formatTokenForEnv, getResolvedApiBase } from "../utils/api-base";

type SignupResponse = {
  id: string;
  token: string;
  tokenPrefix: string;
  role: string;
  userId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  message: string;
};

/**
 * Unauthenticated request for signup (no token required)
 */
async function signupRequest(body: Record<string, unknown>): Promise<SignupResponse> {
  const apiBase = getResolvedApiBase();
  const url = `${apiBase}/v1/signup`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();

  if (!res.ok) {
    const code = json?.error?.code || "SIGNUP_ERROR";
    const msg = json?.error?.message || json?.message || res.statusText;
    throw new Error(`${code}: ${msg}`);
  }

  return json as SignupResponse;
}

export const signupCommand = new Command("signup")
  .description("Create a new user account and token (no auth required)")
  .option("--label <label>", "Optional label for the token")
  .option("--expires-days <days>", "Token expiration in days (optional)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const body: Record<string, unknown> = {};
      if (opts.label) body.label = opts.label;
      if (opts.expiresDays) {
        const days = Number(opts.expiresDays);
        if (!Number.isFinite(days) || days <= 0) {
          console.error("Invalid --expires-days. Provide a positive number.");
          process.exit(2);
        }
        body.expiresInDays = days;
      }

      const result = await signupRequest(body);

      if (opts.json) {
        printJson(result);
      } else {
        const apiBase = getResolvedApiBase();
        const tokenExport = formatTokenForEnv(result.token, apiBase);
        console.log("Account created successfully!");
        console.log("");
        console.log(`  Token:    ${result.token}`);
        console.log(`  User ID:  ${result.userId}`);
        console.log(`  Role:     ${result.role}`);
        console.log(`  Label:    ${result.label}`);
        console.log(`  Expires:  ${result.expiresAt ?? "never"}`);
        console.log("");
        console.log("Save this token securely - it will not be shown again.");
        console.log("");
        console.log("To use this token, set the environment variable:");
        console.log(`  export AGENTCLOUD_TOKEN="${tokenExport}"`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
