import { Pool } from "pg";

// Use SQLite if URL starts with sqlite:, otherwise use Postgres
const dbUrl = process.env.CONTROL_PLANE_DATABASE_URL || "sqlite:./data/control-plane.db";
const isSqlite = dbUrl.startsWith("sqlite:");

let pool: InstanceType<typeof Pool> | any;

if (isSqlite) {
  // SQLite implementation
  const Database = require("better-sqlite3");
  const { join } = require("path");
  const { mkdirSync } = require("fs");
  
  const dbPath = dbUrl.replace("sqlite:", "");
  const fullPath = dbPath.startsWith("/") ? dbPath : join(process.cwd(), dbPath);
  
  // Create directory if needed
  const { dirname } = require("path");
  mkdirSync(dirname(fullPath), { recursive: true });
  
  const db = new Database(fullPath);
  db.pragma("journal_mode = WAL");
  
  pool = {
    query: async (text: string, params?: any[]) => {
      const stmt = db.prepare(text);
      const result = stmt.all(...(params || []));
      return {
        rows: result,
        rowCount: Array.isArray(result) ? result.length : 0,
      };
    },
    end: async () => {
      db.close();
    },
  };
} else {
  // Use Postgres with optimized pool settings
  pool = new Pool({
    connectionString: dbUrl,
    // Pool configuration
    max: Number(process.env.DB_POOL_MAX || 20), // Maximum connections
    min: Number(process.env.DB_POOL_MIN || 2),  // Minimum connections
    idleTimeoutMillis: 30000, // Close idle connections after 30s
    connectionTimeoutMillis: 10000, // Timeout for acquiring connection
    // Statement timeout to prevent long-running queries
    statement_timeout: 30000, // 30 seconds
  });
  
  // Handle pool errors gracefully
  pool.on("error", (err: Error) => {
    console.error("Unexpected database pool error:", err.message);
  });
}

export { pool };

