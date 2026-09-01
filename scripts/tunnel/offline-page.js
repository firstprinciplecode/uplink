"use strict";
// Keep in sync with src/shared/offline-page.ts (router). This copy is for the CJS relay.

const MARKS = {
  tunnel: "↗",
  host: "▣",
  wake: "●",
  missing: "○",
};

function wantsHtml(req) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  return /\btext\/html\b/i.test(String(req.headers?.accept || ""));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clampRefresh(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const n = Math.floor(sec);
  if (n < 1 || n > 30) return null;
  return n;
}

function applySafeHeaders(res, refreshSec) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "font-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "));
  if (refreshSec) res.setHeader("Retry-After", String(refreshSec));
}

function renderOfflinePage(page) {
  const title = escapeHtml(page.title);
  const detail = escapeHtml(page.detail);
  const hint = page.hint ? `<p class="hint">${escapeHtml(page.hint)}</p>` : "";
  const mark = MARKS[page.mark] || MARKS.missing;
  const tone = page.mark === "wake" ? "wake" : page.mark === "host" ? "host" : page.mark === "tunnel" ? "broken" : "";
  const glyph =
    page.mark === "tunnel"
      ? `<span class="chain"><i class="ring a"></i><i class="ring b"></i><i class="slash"></i></span>`
      : `<span>${mark}</span>`;
  const refreshSec = clampRefresh(page.refreshSec);
  const refresh = refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} — uplink</title>
${refresh}
<style>
  :root { --text:#f2f2f2; --dim:#6a6a6a; --mute:#9c9c9c; --line:#333; --ok:#3ecf4a; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: #000; color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 14px; }
  body { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 32px 20px; }
  main { width: min(440px, 100%); text-align: center; }
  .brand { font-size: 11px; letter-spacing: 0.32em; color: #fff; margin-bottom: 32px; }
  .glyph {
    width: 128px; height: 128px; margin: 0 auto 32px;
    border: 1px solid var(--line); border-radius: 10px;
    display: grid; place-items: center;
    font-size: 40px; color: var(--dim);
    box-shadow: inset 0 0 0 1px #111;
  }
  .glyph.host { color: #888; }
  .glyph.wake { border-color: #1d3d22; color: var(--ok); }
  .glyph.wake span { display: block; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.28; } }
  .chain { position: relative; width: 68px; height: 42px; }
  .ring {
    position: absolute; top: 11px; width: 28px; height: 18px;
    border: 2.5px solid #6a6a6a; border-radius: 999px;
  }
  .ring.a { left: 2px; transform: rotate(-42deg); }
  .ring.b { right: 2px; transform: rotate(42deg); }
  .slash {
    position: absolute; left: 50%; top: 3px; width: 2px; height: 36px;
    margin-left: -1px; background: #6a6a6a; border-radius: 1px;
    transform: rotate(32deg);
  }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 12px; }
  p { color: var(--dim); line-height: 1.6; }
  .hint { margin-top: 20px; color: var(--mute); font-size: 12px; }
  .foot { margin-top: 40px; font-size: 12px; }
  a { color: #fff; text-decoration: none; border-bottom: 1px solid #444; }
  a:hover { border-bottom-color: #fff; }
</style>
</head>
<body>
  <main>
    <div class="brand">uplink</div>
    <div class="glyph ${tone}" aria-hidden="true">${glyph}</div>
    <h1>${title}</h1>
    <p>${detail}</p>
    ${hint}
    <p class="foot"><a href="https://uplink.spot" rel="noreferrer noopener">uplink.spot</a></p>
  </main>
</body>
</html>`;
}

function sendOffline(req, res, status, plain, page) {
  if (res.headersSent) return;
  const refreshSec = clampRefresh(page.refreshSec);
  res.statusCode = status;
  applySafeHeaders(res, refreshSec);
  if (wantsHtml(req)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (String(req.method || "").toUpperCase() === "HEAD") {
      res.end();
      return;
    }
    res.end(renderOfflinePage({ ...page, refreshSec: refreshSec ?? undefined }));
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (String(req.method || "").toUpperCase() === "HEAD") {
    res.end();
    return;
  }
  res.end(plain);
}

module.exports = { wantsHtml, renderOfflinePage, sendOffline };
