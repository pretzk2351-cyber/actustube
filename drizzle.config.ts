import { defineConfig } from "drizzle-kit";

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
  ...(directDatabaseUrl
    ? { dbCredentials: { url: directDatabaseUrl } }
    : {}),
});
