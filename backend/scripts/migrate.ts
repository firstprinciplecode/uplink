#!/usr/bin/env tsx
/**
 * Run database migrations
 * Usage: tsx backend/scripts/migrate.ts
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";

const dbUrl = process.env.CONTROL_PLANE_DATABASE_URL || "sqlite:./data/control-plane.db";
const isSqlite = dbUrl.startsWith("sqlite:");

// Get __dirname equivalent that works in both ESM and CommonJS
const getDirname = () => {
  try {
    // @ts-ignore - __dirname may not exist in ESM
    if (typeof __dirname !== "undefined") {
      // @ts-ignore
      return __dirname;
    }
  } catch {}
  // ESM mode: use import.meta.url
  return dirname(fileURLToPath(import.meta.url));
};

/**
 * Remove SQL comments (-- style and /* *\/ style)
 */
function removeComments(sql: string): string {
  return sql
    // Remove /* ... */ comments (including multi-line)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove -- style comments (but preserve -- in strings)
    .split("\n")
    .map(line => {
      const commentIndex = line.indexOf("--");
      if (commentIndex === -1) return line;
      // Check if -- is inside a string (simple heuristic)
      const beforeComment = line.substring(0, commentIndex);
      const singleQuotes = (beforeComment.match(/'/g) || []).length;
      if (singleQuotes % 2 === 0) {
        // Even number of quotes before --, so -- is not in a string
        return line.substring(0, commentIndex).trimEnd();
      }
      return line;
    })
    .join("\n");
}

/**
 * Convert PostgreSQL SQL to SQLite-compatible SQL
 */
function convertPostgresToSqlite(sql: string): string {
  return sql
    // TIMESTAMPTZ -> TEXT (SQLite doesn't have native timestamp types)
    .replace(/\bTIMESTAMPTZ\b/gi, "TEXT")
    // NOW() -> (datetime('now'))
    .replace(/\bNOW\(\)/gi, "(datetime('now'))")
    // CURRENT_TIMESTAMP -> (datetime('now'))
    .replace(/\bCURRENT_TIMESTAMP\b/gi, "(datetime('now'))")
    // BIGINT -> INTEGER (SQLite doesn't distinguish)
    .replace(/\bBIGINT\b/gi, "INTEGER")
    // ALTER TABLE ... ADD COLUMN IF NOT EXISTS -> remove IF NOT EXISTS (SQLite < 3.38)
    // We'll handle the error gracefully instead
    .replace(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+IF NOT EXISTS/gi, "ALTER TABLE $1 ADD COLUMN");
}

async function migrate() {
  console.log("Running migrations...");
  console.log(`Database: ${isSqlite ? "SQLite" : "Postgres"}`);

  // Run all migrations in order
  const migrations = [
    "001_create_databases.sql",
    "002_create_tunnels.sql",
    "003_create_tokens.sql",
    "004_create_tunnel_aliases.sql",
    "005_add_alias_limit.sql",
    "006_alias_traffic_stats.sql",
    "007_port_based_aliases.sql",
    "008_create_apps.sql",
    "009_hosting_runtime_fields.sql",
  ];

  if (isSqlite) {
    // SQLite migration
    const Database = require("better-sqlite3");
    const dbPath = dbUrl.replace("sqlite:", "");
    const { join: pathJoin } = require("path");
    const fullPath = dbPath.startsWith("/") ? dbPath : pathJoin(process.cwd(), dbPath);
    
    // Create directory if needed
    const { dirname } = require("path");
    mkdirSync(dirname(fullPath), { recursive: true });
    
    const db = new Database(fullPath);
    db.pragma("journal_mode = WAL");
    
    const migrationsDir = join(getDirname(), "../migrations");
    for (const migrationFile of migrations) {
      const migrationPath = join(migrationsDir, migrationFile);
      let sql = readFileSync(migrationPath, "utf-8");
      
      // Remove comments first (before conversion)
      sql = removeComments(sql);
      
      // Convert PostgreSQL syntax to SQLite
      sql = convertPostgresToSqlite(sql);
      
      try {
        // Split SQL by semicolon and execute each statement
        const statements = sql.split(";").filter(s => s.trim());
        for (const stmt of statements) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              db.exec(trimmed);
            } catch (stmtErr: any) {
              // SQLite-specific: ignore "duplicate column name" errors
              if (stmtErr.message?.includes("duplicate column name") || 
                  stmtErr.message?.includes("already exists")) {
                // Column/table/index already exists, skip
                continue;
              }
              throw stmtErr;
            }
          }
        }
        console.log(`✅ ${migrationFile} completed`);
      } catch (err: any) {
        if (err.message.includes("already exists") || 
            err.message.includes("duplicate column name")) {
          console.log(`✅ ${migrationFile} - already applied, skipping`);
        } else {
          console.error(`Migration ${migrationFile} failed:`, err);
          process.exit(1);
        }
      }
    }
    db.close();
    console.log("✅ All migrations completed (SQLite)");
  } else {
    // Postgres migration
    const { pool } = require("../src/db/pool");
    try {
      const migrationsDir = join(getDirname(), "../migrations");
      for (const migrationFile of migrations) {
        const migrationPath = join(migrationsDir, migrationFile);
        const sql = readFileSync(migrationPath, "utf-8");
        
        try {
          await pool.query(sql);
          console.log(`✅ ${migrationFile} completed`);
        } catch (err: any) {
          if (err.code === "42P07" || err.message?.includes("already exists")) {
            console.log(`✅ ${migrationFile} - tables already exist, skipping`);
          } else {
            console.error(`Migration ${migrationFile} failed:`, err);
            throw err;
          }
        }
      }
      console.log("✅ All migrations completed (Postgres)");
    } catch (err: any) {
      console.error("Migration failed:", err);
      process.exit(1);
    } finally {
      await pool.end();
    }
  }
}

migrate();

