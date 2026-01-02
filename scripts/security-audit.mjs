// Non-destructive security probe for Uplink's public/internal surfaces.
// - Does NOT create tokens or tunnels
// - Logs only status codes + non-sensitive metadata
//
// Usage:
//   API_BASE=https://api.uplink.spot node scripts/security-audit.mjs

// NOTE: This script previously sent debug telemetry to a local NDJSON ingest endpoint.
// That instrumentation has been removed; the script is now standalone and prints only to stdout.

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
    // Cache/proxy visibility (useful to detect CDN caching of 403s)
    "cache-control": h.get("cache-control"),
    "cf-cache-status": h.get("cf-cache-status"),
    "cf-ray": h.get("cf-ray"),
    "via": h.get("via"),
    "x-cache": h.get("x-cache"),
    // RateLimit-* headers (express-rate-limit)
    "ratelimit-limit": h.get("ratelimit-limit"),
    "ratelimit-remaining": h.get("ratelimit-remaining"),
    "ratelimit-reset": h.get("ratelimit-reset"),
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
  const apiBase = (process.env.API_BASE || "https://api.uplink.spot").replace(/\/$/, "");
  const tunnelDomain = process.env.TUNNEL_DOMAIN || "x.uplink.spot";

  // Hypothesis A: internal endpoints are not adequately protected if relay secret is unset/misconfigured.
  // We expect /internal/resolve-alias to return 403 without the secret.
  const resolveAlias = await fetchWithMeta(
    `${apiBase}/internal/resolve-alias?alias=this-should-not-exist`,
    { method: "GET" }
  );

  // Hypothesis B: /internal/allow-tls can be abused for token enumeration and should be rate-limited and/or authenticated.
  // We expect 403 for random token and ideally 429 after repeated requests.
  const sampleToken = "aaaaaaaaaaaa"; // intentionally not a real token
  const allowTlsUrl = `${apiBase}/internal/allow-tls?domain=${sampleToken}.${tunnelDomain}`;
  const allowTlsFirst = await fetchWithMeta(allowTlsUrl, { method: "GET" });

  // Small burst to see if any limiting is applied (keep very low to avoid load).
  const burstN = Number(process.env.ALLOW_TLS_BURST || 20);
  const burst = [];
  for (let i = 0; i < burstN; i++) {
    // IMPORTANT: add per-request nonce to prevent upstream caching from hiding rate limiting.
    burst.push(fetchWithMeta(`${allowTlsUrl}&nonce=${i}_${Date.now()}`, { method: "GET" }));
  }
  const burstRes = await Promise.all(burst);
  const statusCounts = burstRes.reduce((acc, r) => {
    const k = r.ok ? String(r.status) : "ERR";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  // Hypothesis C: basic security headers should be present for public endpoints.
  const health = await fetchWithMeta(`${apiBase}/health`, { method: "GET" });

  // Hypothesis D: /v1 is globally rate-limited (we check headers existence only; we do not spam).
  const v1Health = await fetchWithMeta(`${apiBase}/v1/me`, {
    method: "GET",
    headers: { authorization: "Bearer invalid" },
  });

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

