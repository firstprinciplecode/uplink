import Database from "better-sqlite3";
import { join } from "path";

// Use SQLite if CONTROL_PLANE_DATABASE_URL is not set or starts with sqlite:
const dbUrl = process.env.CONTROL_PLANE_DATABASE_URL || "sqlite:./data/control-plane.db";
const isSqlite = dbUrl.startsWith("sqlite:");

let db: Database.Database | null = null;

if (isSqlite) {
  const dbPath = dbUrl.replace("sqlite:", "");
  const fullPath = dbPath.startsWith("/") ? dbPath : join(process.cwd(), dbPath);
  db = new Database(fullPath);
  db.pragma("journal_mode = WAL");
  console.log(`Using SQLite database: ${fullPath}`);
}

export { db };

// For compatibility with pg Pool interface
export const pool = {
  query: async (text: string, params?: any[]) => {
    if (!db) {
      throw new Error("Database not initialized. Set CONTROL_PLANE_DATABASE_URL");
    }

    const stmt = db.prepare(text);
    const result = stmt.all(...(params || []));
    
    return {
      rows: result,
      rowCount: Array.isArray(result) ? result.length : 0,
    };
  },
  end: async () => {
    if (db) {
      db.close();
      db = null;
    }
  },
};





