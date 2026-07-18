import "server-only";

import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";

import * as schema from "./schema";

export type Database = NeonHttpDatabase<typeof schema>;

export class DatabaseConfigurationError extends Error {
  constructor() {
    super("Database configuration is unavailable.");
    this.name = "DatabaseConfigurationError";
  }
}

let database: Database | undefined;

export function getDatabase(): Database {
  if (database) return database;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new DatabaseConfigurationError();
  }

  const client = neon(databaseUrl);
  database = drizzle({ client, schema });
  return database;
}

export function resetDatabaseForTests() {
  if (process.env.NODE_ENV !== "test") return;
  database = undefined;
}
