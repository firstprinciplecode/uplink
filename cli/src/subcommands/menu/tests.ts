import fetch from "node-fetch";
import { spawn } from "child_process";
import { resolveProjectRoot } from "../../utils/project-root";

export function runSmoke(script: "smoke:tunnel" | "smoke:db" | "smoke:all" | "test:comprehensive") {
  return new Promise<void>((resolve, reject) => {
    const projectRoot = resolveProjectRoot(__dirname);
    const env = {
      ...process.env,
      AGENTCLOUD_API_BASE: process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot",
      AGENTCLOUD_TOKEN: process.env.AGENTCLOUD_TOKEN,
    };

    if (script === "test:comprehensive") {
      runComprehensiveTest(env).then(resolve).catch(reject);
      return;
    }

    const child = spawn("npm", ["run", script], {
      stdio: "inherit",
      env,
      cwd: projectRoot,
      shell: true,
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} failed with exit code ${code}`));
      }
    });
    child.on("error", (err) => reject(err));
  });
}

async function runComprehensiveTest(env: Record<string, string | undefined>) {
  const API_BASE = env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
  const ADMIN_TOKEN = env.AGENTCLOUD_TOKEN || "";

  const c = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
  };

  let PASSED = 0;
  let FAILED = 0;
  let SKIPPED = 0;

  const logPass = (msg: string) => {
    console.log(`${c.green}✅ PASS${c.reset}: ${msg}`);
    PASSED++;
  };
  const logFail = (msg: string) => {
    console.log(`${c.red}❌ FAIL${c.reset}: ${msg}`);
    FAILED++;
  };
  const logSkip = (msg: string) => {
    console.log(`${c.yellow}⏭️  SKIP${c.reset}: ${msg}`);
    SKIPPED++;
  };
  const logInfo = (msg: string) => {
    console.log(`${c.blue}ℹ️  INFO${c.reset}: ${msg}`);
  };
  const logSection = (title: string) => {
    console.log(`\n${c.blue}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.blue}  ${title}${c.reset}`);
    console.log(`${c.blue}═══════════════════════════════════════════════════════════${c.reset}`);
  };

  const api = async (method: string, path: string, body?: object, token?: string) => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      let responseBody: any;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = {};
      }
      return { status: res.status, body: responseBody };
    } catch (err: any) {
      return { status: 0, body: { error: err.message } };
    }
  };

  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║       UPLINK COMPREHENSIVE TEST SUITE                     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log(`\nAPI Base: ${API_BASE}\n`);

  if (!ADMIN_TOKEN) {
    console.log(`${c.red}ERROR: AGENTCLOUD_TOKEN not set.${c.reset}`);
    throw new Error("AGENTCLOUD_TOKEN not set");
  }

  logSection("1. HEALTH CHECKS");
  let res = await api("GET", "/health");
  if (res.status === 200 && res.body?.status === "ok") logPass("GET /health returns 200");
  else logFail(`GET /health - got ${res.status}`);

  res = await api("GET", "/health/live");
  if (res.status === 200) logPass("GET /health/live returns 200");
  else logFail(`GET /health/live - got ${res.status}`);

  logSection("2. AUTHENTICATION");
  res = await api("GET", "/v1/me");
  if (res.status === 401) logPass("Missing token returns 401");
  else logFail(`Missing token - got ${res.status}`);

  res = await api("GET", "/v1/me", undefined, "invalid-token");
  if (res.status === 401) logPass("Invalid token returns 401");
  else logFail(`Invalid token - got ${res.status}`);

  res = await api("GET", "/v1/me", undefined, ADMIN_TOKEN);
  if (res.status === 200 && res.body?.role === "admin") logPass("Valid admin token works");
  else logFail(`Admin token - got ${res.status}`);

  logSection("3. SIGNUP FLOW");
  let USER_TOKEN = "";
  let USER_TOKEN_ID = "";
  res = await api("POST", "/v1/signup", { label: `test-${Date.now()}` });
  if (res.status === 201 && res.body?.token) {
    USER_TOKEN = res.body.token;
    USER_TOKEN_ID = res.body.id;
    logPass("POST /v1/signup creates token");
    if (res.body.role === "user") logPass("Signup creates user role");
    else logFail(`Signup role: ${res.body.role}`);
  } else if (res.status === 429) {
    logSkip("Signup rate limited");
  } else {
    logFail(`Signup - got ${res.status}`);
  }

  logSection("4. AUTHORIZATION");
  if (USER_TOKEN) {
    res = await api("GET", "/v1/admin/stats", undefined, USER_TOKEN);
    if (res.status === 403) logPass("User blocked from admin endpoint");
    else logFail(`User accessed admin - got ${res.status}`);
  } else {
    logSkip("No user token for auth tests");
  }

  logSection("5. TUNNEL API");
  res = await api("GET", "/v1/tunnels", undefined, ADMIN_TOKEN);
  if (res.status === 200) logPass("GET /v1/tunnels works");
  else logFail(`Tunnels list - got ${res.status}`);

  res = await api("POST", "/v1/tunnels", { port: 3000 }, ADMIN_TOKEN);
  if (res.status === 201) {
    logPass("POST /v1/tunnels creates tunnel");
    if (res.body?.id) {
      const delRes = await api("DELETE", `/v1/tunnels/${res.body.id}`, undefined, ADMIN_TOKEN);
      if (delRes.status === 200) logPass("DELETE tunnel works");
      else logFail(`Delete tunnel - got ${delRes.status}`);
    }
  } else {
    logFail(`Create tunnel - got ${res.status}`);
  }

  logSection("6. DATABASE API");
  res = await api("GET", "/v1/dbs", undefined, ADMIN_TOKEN);
  if (res.status === 200) logPass("GET /v1/dbs works");
  else logFail(`Databases list - got ${res.status}`);
  logInfo("Skipping DB creation (provisions real resources)");

  logSection("7. ADMIN STATS");
  res = await api("GET", "/v1/admin/stats", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    logPass("GET /v1/admin/stats works");
    if (res.body?.tunnels !== undefined) logPass("Stats include tunnels");
    if (res.body?.databases !== undefined) logPass("Stats include databases");
  } else {
    logFail(`Admin stats - got ${res.status}`);
  }

  logSection("8. CLEANUP");
  if (USER_TOKEN_ID) {
    res = await api("DELETE", `/v1/admin/tokens/${USER_TOKEN_ID}`, undefined, ADMIN_TOKEN);
    if (res.status === 200) logPass("Cleaned up test token");
    else logInfo("Could not clean up token");
  } else {
    logInfo("No test token to clean up");
  }

  logSection("TEST SUMMARY");
  console.log(`\n  ${c.green}Passed${c.reset}:  ${PASSED}`);
  console.log(`  ${c.red}Failed${c.reset}:  ${FAILED}`);
  console.log(`  ${c.yellow}Skipped${c.reset}: ${SKIPPED}\n`);

  if (FAILED === 0) {
    console.log(`${c.green}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.green}  ✅ ALL TESTS PASSED (${PASSED}/${PASSED + FAILED})${c.reset}`);
    console.log(`${c.green}═══════════════════════════════════════════════════════════${c.reset}`);
  } else {
    console.log(`${c.red}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.red}  ❌ SOME TESTS FAILED (${FAILED}/${PASSED + FAILED})${c.reset}`);
    console.log(`${c.red}═══════════════════════════════════════════════════════════${c.reset}`);
    throw new Error(`${FAILED} tests failed`);
  }
}
