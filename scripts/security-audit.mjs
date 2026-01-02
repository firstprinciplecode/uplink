// Non-destructive security probe for Uplink's public/internal surfaces.
// - Does NOT create tokens or tunnels
// - Logs only status codes + non-sensitive metadata
//
// Usage:
//   API_BASE=https://api.uplink.spot node scripts/security-audit.mjs

const LOG_ENDPOINT =
  "http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76";

function log({ runId, hypothesisId, location, message, data }) {
  fetch(LOG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "debug-session",
      timestamp: Date.now(),
      runId,
      hypothesisId,
      location,
      message,
      data,
    }),
  }).catch(() => {});
}

function pickHeaders(res) {
  const h = res.headers;
  return {
    "content-type": h.get("content-type"),
    "strict-transport-security": h.get("strict-transport-security"),
    "x-content-type-options": h.get("x-content-type-options"),
    "x-frame-options": h.get("x-frame-options"),
    "content-security-policy": h.get("content-security-policy"),
    "referrer-policy": h.get("referrer-policy"),
    "permissions-policy": h.get("permissions-policy"),
    "server": h.get("server"),
  };
}

async function fetchWithMeta(url, init) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { ok: false, error: String(e), url, durationMs: Date.now() - startedAt };
  }
  return {
    ok: true,
    url,
    status: res.status,
    durationMs: Date.now() - startedAt,
    headers: pickHeaders(res),
  };
}

async function main() {
  const runId = `sec_audit_${Date.now()}`;
  const apiBase = (process.env.API_BASE || "https://api.uplink.spot").replace(/\/$/, "");
  const tunnelDomain = process.env.TUNNEL_DOMAIN || "x.uplink.spot";

  // #region agent log helper (debug instrumentation)
  log({
    runId,
    hypothesisId: "BOOT",
    location: "scripts/security-audit.mjs:main",
    message: "Starting security audit probe",
    data: { apiBase, tunnelDomain },
  });
  // #endregion

  // Hypothesis A: internal endpoints are not adequately protected if relay secret is unset/misconfigured.
  // We expect /internal/resolve-alias to return 403 without the secret.
  const resolveAlias = await fetchWithMeta(
    `${apiBase}/internal/resolve-alias?alias=this-should-not-exist`,
    { method: "GET" }
  );
  // #region agent log helper (debug instrumentation)
  log({
    runId,
    hypothesisId: "A",
    location: "scripts/security-audit.mjs:resolve-alias",
    message: "Checked /internal/resolve-alias without relay secret",
    data: resolveAlias,
  });
  // #endregion

  // Hypothesis B: /internal/allow-tls can be abused for token enumeration and should be rate-limited and/or authenticated.
  // We expect 403 for random token and ideally 429 after repeated requests.
  const sampleToken = "aaaaaaaaaaaa"; // intentionally not a real token
  const allowTlsUrl = `${apiBase}/internal/allow-tls?domain=${sampleToken}.${tunnelDomain}`;
  const allowTlsFirst = await fetchWithMeta(allowTlsUrl, { method: "GET" });
  // #region agent log helper (debug instrumentation)
  log({
    runId,
    hypothesisId: "B",
    location: "scripts/security-audit.mjs:allow-tls:first",
    message: "Checked /internal/allow-tls once",
    data: allowTlsFirst,
  });
  // #endregion

  // Small burst to see if any limiting is applied (keep very low to avoid load).
  const burstN = Number(process.env.ALLOW_TLS_BURST || 20);
  const burst = [];
  for (let i = 0; i < burstN; i++) {
    burst.push(fetchWithMeta(allowTlsUrl, { method: "GET" }));
  }
  const burstRes = await Promise.all(burst);
  const statusCounts = burstRes.reduce((acc, r) => {
    const k = r.ok ? String(r.status) : "ERR";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  // #region agent log helper (debug instrumentation)
  log({
    runId,
    hypothesisId: "B",
    location: "scripts/security-audit.mjs:allow-tls:burst",
    message: "Checked /internal/allow-tls burst status distribution",
    data: { burstN, statusCounts },
  });
  // #endregion

  // Hypothesis C: basic security headers should be present for public endpoints.
  const health = await fetchWithMeta(`${apiBase}/health`, { method: "GET" });
  // #region agent log helper (debug instrumentation)
  log({
    runId,
    hypothesisId: "C",
    location: "scripts/security-audit.mjs:health",
    message: "Checked /health headers",
    data: health,
  });
  // #endregion

  // Hypothesis D: /v1 is globally rate-limited (we check headers existence only; we do not spam).
  const v1Health = await fetchWithMeta(`${apiBase}/v1/me`, {
    method: "GET",
    headers: { authorization: "Bearer invalid" },
  });
  // #region agent log helper (debug instrumentation)
  log({
    runId,
    hypothesisId: "D",
    location: "scripts/security-audit.mjs:v1-me",
    message: "Checked /v1/me unauth response shape + headers",
    data: v1Health,
  });
  // #endregion

  // Print a tiny local summary (no secrets).
  console.log("Security audit probe complete.");
  console.log(`API_BASE=${apiBase}`);
  console.log(`- /internal/resolve-alias status: ${resolveAlias.ok ? resolveAlias.status : "ERR"}`);
  console.log(`- /internal/allow-tls first status: ${allowTlsFirst.ok ? allowTlsFirst.status : "ERR"}`);
  console.log(`- /internal/allow-tls burst counts: ${JSON.stringify(statusCounts)}`);
  console.log(`- /health status: ${health.ok ? health.status : "ERR"}`);
  console.log(`- /v1/me (invalid token) status: ${v1Health.ok ? v1Health.status : "ERR"}`);
}

main().catch((e) => {
  console.error("Security audit probe failed:", e);
  process.exitCode = 1;
});

