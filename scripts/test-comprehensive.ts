#!/usr/bin/env tsx
/**
 * Comprehensive test suite for Uplink API
 * Tests authentication, authorization, signup, tokens, tunnels, and databases
 * 
 * Node.js version - no external dependencies like curl
 */

import fetch from "node-fetch";

// Configuration
const API_BASE = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
const ADMIN_TOKEN = process.env.AGENTCLOUD_TOKEN || "";
const TIMEOUT_MS = 15000;

// Colors
const c = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

// Counters
let PASSED = 0;
let FAILED = 0;
let SKIPPED = 0;

// Test context
let USER_TOKEN = "";
let USER_TOKEN_ID = "";

function logPass(msg: string) {
  console.log(`${c.green}✅ PASS${c.reset}: ${msg}`);
  PASSED++;
}

function logFail(msg: string) {
  console.log(`${c.red}❌ FAIL${c.reset}: ${msg}`);
  FAILED++;
}

function logSkip(msg: string) {
  console.log(`${c.yellow}⏭️  SKIP${c.reset}: ${msg}`);
  SKIPPED++;
}

function logInfo(msg: string) {
  console.log(`${c.blue}ℹ️  INFO${c.reset}: ${msg}`);
}

function logSection(title: string) {
  console.log(`\n${c.blue}═══════════════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.blue}  ${title}${c.reset}`);
  console.log(`${c.blue}═══════════════════════════════════════════════════════════${c.reset}`);
}

// HTTP request helper
async function api(
  method: string,
  path: string,
  body?: object,
  token?: string
): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let responseBody: any;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = {};
    }

    return { status: response.status, body: responseBody };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { status: 0, body: { error: "Request timeout" } };
    }
    return { status: 0, body: { error: err.message } };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// SECTION 1: Health Checks
// ============================================================================
async function testHealth() {
  logSection("1. HEALTH CHECKS");

  // Test /health endpoint (no auth required)
  let res = await api("GET", "/health");
  if (res.status === 200 && res.body?.status === "ok") {
    logPass("GET /health returns 200 with status ok");
  } else {
    logFail(`GET /health - expected 200 with ok, got ${res.status}`);
  }

  // Test /health/live endpoint
  res = await api("GET", "/health/live");
  if (res.status === 200) {
    logPass("GET /health/live returns 200");
  } else {
    logFail(`GET /health/live - expected 200, got ${res.status}`);
  }

  // Test /health/ready endpoint
  res = await api("GET", "/health/ready");
  if (res.status === 200) {
    logPass("GET /health/ready returns 200");
  } else {
    logFail(`GET /health/ready - expected 200, got ${res.status}`);
  }
}

// ============================================================================
// SECTION 2: Authentication Tests
// ============================================================================
async function testAuthentication() {
  logSection("2. AUTHENTICATION");

  // Test missing token
  let res = await api("GET", "/v1/me");
  if (res.status === 401) {
    logPass("Missing token returns 401");
  } else {
    logFail(`Missing token - expected 401, got ${res.status}`);
  }

  // Test invalid token
  res = await api("GET", "/v1/me", undefined, "invalid-token-12345");
  if (res.status === 401) {
    logPass("Invalid token returns 401");
  } else {
    logFail(`Invalid token - expected 401, got ${res.status}`);
  }

  // Test valid admin token
  res = await api("GET", "/v1/me", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    if (res.body?.role === "admin") {
      logPass("Valid admin token returns 200 with role=admin");
    } else {
      logFail(`Admin token returned role=${res.body?.role} instead of admin`);
    }
  } else {
    logFail(`Valid token - expected 200, got ${res.status}`);
  }
}

// ============================================================================
// SECTION 3: Signup Flow (Public Endpoint)
// ============================================================================
async function testSignup() {
  logSection("3. SIGNUP FLOW");

  const label = `test-signup-${Date.now()}`;
  const res = await api("POST", "/v1/signup", { label });

  if (res.status === 201) {
    USER_TOKEN = res.body?.token || "";
    USER_TOKEN_ID = res.body?.id || "";
    const userRole = res.body?.role;

    if (USER_TOKEN) {
      logPass("POST /v1/signup creates token (status 201)");

      // Verify role is user (not admin)
      if (userRole === "user") {
        logPass("Signup creates user role (not admin)");
      } else {
        logFail(`Signup created role=${userRole} instead of user`);
      }

      // Test the new token works
      const meRes = await api("GET", "/v1/me", undefined, USER_TOKEN);
      if (meRes.status === 200) {
        logPass("New user token is valid");
      } else {
        logFail(`New user token doesn't work - status ${meRes.status}`);
      }
    } else {
      logFail("Signup didn't return a token");
    }
  } else if (res.status === 429) {
    logSkip("Signup rate limited (429) - try again later");
    USER_TOKEN = "";
    USER_TOKEN_ID = "";
  } else {
    logFail(`POST /v1/signup - expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    USER_TOKEN = "";
    USER_TOKEN_ID = "";
  }
}

// ============================================================================
// SECTION 4: Authorization (Role-Based Access)
// ============================================================================
async function testAuthorization() {
  logSection("4. AUTHORIZATION (Role-Based Access)");

  if (!USER_TOKEN) {
    logSkip("User token not available - skipping authorization tests");
    return;
  }

  // Test user can't access admin endpoints
  let res = await api("GET", "/v1/admin/stats", undefined, USER_TOKEN);
  if (res.status === 403) {
    logPass("User token blocked from /v1/admin/stats (403)");
  } else {
    logFail(`User accessed admin endpoint - expected 403, got ${res.status}`);
  }

  res = await api("GET", "/v1/admin/tokens", undefined, USER_TOKEN);
  if (res.status === 403) {
    logPass("User token blocked from /v1/admin/tokens (403)");
  } else {
    logFail(`User accessed admin tokens - expected 403, got ${res.status}`);
  }

  res = await api("GET", "/v1/admin/tunnels", undefined, USER_TOKEN);
  if (res.status === 403) {
    logPass("User token blocked from /v1/admin/tunnels (403)");
  } else {
    logFail(`User accessed admin tunnels - expected 403, got ${res.status}`);
  }

  // Test admin CAN access admin endpoints
  res = await api("GET", "/v1/admin/stats", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    logPass("Admin token can access /v1/admin/stats");
  } else {
    logFail(`Admin blocked from admin endpoint - status ${res.status}`);
  }
}

// ============================================================================
// SECTION 5: Token Management (Admin Only)
// ============================================================================
async function testTokenManagement() {
  logSection("5. TOKEN MANAGEMENT (Admin)");

  // List tokens
  let res = await api("GET", "/v1/admin/tokens", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    const count = res.body?.count ?? res.body?.tokens?.length ?? 0;
    logPass(`GET /v1/admin/tokens returns 200 (count: ${count})`);
  } else {
    logFail(`GET /v1/admin/tokens - expected 200, got ${res.status}`);
  }

  // Create a test token
  const tokenLabel = `test-token-${Date.now()}`;
  res = await api("POST", "/v1/admin/tokens", { role: "user", label: tokenLabel }, ADMIN_TOKEN);
  if (res.status === 201) {
    const createdTokenId = res.body?.id;
    logPass("POST /v1/admin/tokens creates token (status 201)");

    // Revoke the test token
    if (createdTokenId) {
      const delRes = await api("DELETE", `/v1/admin/tokens/${createdTokenId}`, undefined, ADMIN_TOKEN);
      if (delRes.status === 200) {
        logPass("DELETE /v1/admin/tokens/:id revokes token");
      } else {
        logFail(`Token revocation - expected 200, got ${delRes.status}`);
      }
    }
  } else {
    logFail(`POST /v1/admin/tokens - expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
}

// ============================================================================
// SECTION 6: Tunnel API
// ============================================================================
async function testTunnels() {
  logSection("6. TUNNEL API");

  // List tunnels
  let res = await api("GET", "/v1/tunnels", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    logPass("GET /v1/tunnels returns 200");
  } else {
    logFail(`GET /v1/tunnels - expected 200, got ${res.status}`);
  }

  // Create tunnel
  res = await api("POST", "/v1/tunnels", { port: 3000 }, ADMIN_TOKEN);
  if (res.status === 201) {
    const tunnelId = res.body?.id;
    logPass("POST /v1/tunnels creates tunnel (status 201)");

    // Delete the test tunnel
    if (tunnelId) {
      const delRes = await api("DELETE", `/v1/tunnels/${tunnelId}`, undefined, ADMIN_TOKEN);
      if (delRes.status === 200) {
        logPass("DELETE /v1/tunnels/:id deletes tunnel");
      } else {
        logFail(`Tunnel deletion - expected 200, got ${delRes.status}`);
      }
    }
  } else {
    logFail(`POST /v1/tunnels - expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }

  // Test missing port validation
  res = await api("POST", "/v1/tunnels", {}, ADMIN_TOKEN);
  if (res.status === 400) {
    logPass("POST /v1/tunnels without port returns 400");
  } else {
    logFail(`Missing port validation - expected 400, got ${res.status}`);
  }

  // Test invalid port validation
  res = await api("POST", "/v1/tunnels", { port: "not-a-number" }, ADMIN_TOKEN);
  if (res.status === 400) {
    logPass("POST /v1/tunnels with invalid port returns 400");
  } else {
    logFail(`Invalid port validation - expected 400, got ${res.status}`);
  }
}

// ============================================================================
// SECTION 7: Database API
// ============================================================================
async function testDatabases() {
  logSection("7. DATABASE API");

  // List databases
  const res = await api("GET", "/v1/dbs", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    logPass("GET /v1/dbs returns 200");
  } else {
    logFail(`GET /v1/dbs - expected 200, got ${res.status}`);
  }

  // Note: We don't test database creation as it provisions real resources
  logInfo("Skipping database creation test (provisions real resources)");
}

// ============================================================================
// SECTION 8: Admin Stats
// ============================================================================
async function testAdminStats() {
  logSection("8. ADMIN STATS");

  const res = await api("GET", "/v1/admin/stats", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    logPass("GET /v1/admin/stats returns 200");

    // Check structure
    if (res.body?.tunnels !== undefined) {
      logPass("Stats include tunnels data");
    } else {
      logFail("Stats missing tunnels data");
    }

    if (res.body?.databases !== undefined) {
      logPass("Stats include databases data");
    } else {
      logFail("Stats missing databases data");
    }
  } else {
    logFail(`GET /v1/admin/stats - expected 200, got ${res.status}`);
  }
}

// ============================================================================
// SECTION 9: Cleanup
// ============================================================================
async function cleanupTestData() {
  logSection("9. CLEANUP");

  if (USER_TOKEN_ID) {
    const res = await api("DELETE", `/v1/admin/tokens/${USER_TOKEN_ID}`, undefined, ADMIN_TOKEN);
    if (res.status === 200) {
      logPass("Cleaned up test user token");
    } else {
      logInfo("Could not clean up test token (may already be deleted)");
    }
  } else {
    logInfo("No test user token to clean up");
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║       UPLINK COMPREHENSIVE TEST SUITE                     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`API Base: ${API_BASE}`);
  console.log("");

  if (!ADMIN_TOKEN) {
    console.log(`${c.red}ERROR: AGENTCLOUD_TOKEN not set. Please set an admin token.${c.reset}`);
    process.exit(1);
  }

  await testHealth();
  await testAuthentication();
  await testSignup();
  await testAuthorization();
  await testTokenManagement();
  await testTunnels();
  await testDatabases();
  await testAdminStats();
  await cleanupTestData();

  // Summary
  logSection("TEST SUMMARY");
  console.log("");
  console.log(`  ${c.green}Passed${c.reset}:  ${PASSED}`);
  console.log(`  ${c.red}Failed${c.reset}:  ${FAILED}`);
  console.log(`  ${c.yellow}Skipped${c.reset}: ${SKIPPED}`);
  console.log("");

  const TOTAL = PASSED + FAILED;
  if (FAILED === 0) {
    console.log(`${c.green}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.green}  ✅ ALL TESTS PASSED (${PASSED}/${TOTAL})${c.reset}`);
    console.log(`${c.green}═══════════════════════════════════════════════════════════${c.reset}`);
    process.exit(0);
  } else {
    console.log(`${c.red}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.red}  ❌ SOME TESTS FAILED (${FAILED}/${TOTAL} failed)${c.reset}`);
    console.log(`${c.red}═══════════════════════════════════════════════════════════${c.reset}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});


