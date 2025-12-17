import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import { dbRouter } from "./routes/dbs";
import { tunnelRouter, tunnelTokenExists } from "./routes/tunnels";
import { adminRouter } from "./routes/admin";
import { meRouter } from "./routes/me";
import { authMiddleware } from "./middleware/auth";

const app = express();
app.use(bodyParser.json());

// Health check (no auth)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Allow on-demand TLS (Caddy ask endpoint) - no auth
app.get("/internal/allow-tls", async (req, res) => {
  try {
    const domain = (req.query.domain as string) || (req.query.host as string) || "";
    const host = domain.split(":")[0].trim().toLowerCase();

    // Expect <token>.<TUNNEL_DOMAIN>
    const tunnelDomain = (process.env.TUNNEL_DOMAIN || "t.uplink.spot").toLowerCase();
    if (!host.endsWith(`.${tunnelDomain}`)) {
      return res.status(403).json({ allow: false });
    }

    const token = host.slice(0, -(tunnelDomain.length + 1));
    if (!/^[a-zA-Z0-9]{3,64}$/.test(token)) {
      return res.status(403).json({ allow: false });
    }

    const exists = await tunnelTokenExists(token);
    if (exists) {
      return res.json({ allow: true });
    }
    return res.status(403).json({ allow: false });
  } catch (error) {
    console.error("Error in allow-tls:", error);
    return res.status(500).json({ allow: false });
  }
});

// Auth middleware for all /v1 routes
app.use("/v1", authMiddleware);
app.use("/v1/dbs", dbRouter);
app.use("/v1/tunnels", tunnelRouter);
app.use("/v1/admin", adminRouter);
app.use("/v1/me", meRouter);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Control plane listening on :${port}`);
  console.log(`Neon API Key: ${process.env.NEON_API_KEY ? "set" : "missing"}`);
  console.log(`Neon Project ID: ${process.env.NEON_PROJECT_ID || "missing"}`);
});

