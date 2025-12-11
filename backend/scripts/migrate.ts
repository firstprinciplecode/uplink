#!/usr/bin/env tsx
/**
 * Run database migrations
 * Usage: tsx backend/scripts/migrate.ts
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";

const dbUrl = process.env.CONTROL_PLANE_DATABASE_URL || "sqlite:./data/control-plane.db";
const isSqlite = dbUrl.startsWith("sqlite:");

async function migrate() {
  console.log("Running migrations...");
  console.log(`Database: ${isSqlite ? "SQLite" : "Postgres"}`);

  // Run all migrations in order
  const migrations = [
    "001_create_databases.sql",
    "002_create_tunnels.sql",
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
    
    for (const migrationFile of migrations) {
      const migrationPath = join(__dirname, "../migrations", migrationFile);
      const sql = readFileSync(migrationPath, "utf-8");
      
      try {
        // Split SQL by semicolon and execute each statement
        const statements = sql.split(";").filter(s => s.trim());
        for (const stmt of statements) {
          if (stmt.trim()) {
            db.exec(stmt);
          }
        }
        console.log(`✅ ${migrationFile} completed`);
      } catch (err: any) {
        if (err.message.includes("already exists")) {
          console.log(`✅ ${migrationFile} - tables already exist, skipping`);
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
      for (const migrationFile of migrations) {
        const migrationPath = join(__dirname, "../migrations", migrationFile);
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

