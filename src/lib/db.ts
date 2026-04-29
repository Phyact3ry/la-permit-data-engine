/**
 * db.ts — shared Drizzle ORM + pg connection
 * Загружает .env сам, чтобы работать независимо от точки входа.
 */
import * as dotenv from "dotenv";
dotenv.config();

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — check your .env file");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,               // небольшой pool для serverless-style Inngest воркеров
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: { rejectUnauthorized: false }, // required for Supabase pooler (port 6543)
});

pool.on("error", (err) => {
  console.error("[pg-pool] Unexpected error on idle client:", err.message);
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
