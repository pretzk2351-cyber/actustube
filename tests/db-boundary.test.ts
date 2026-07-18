import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("database server boundary", () => {
  it("does not connect at module load and fails safely only when requested", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.resetModules();

    const databaseModule = await import("@/db/client");
    expect(() => databaseModule.getDatabase()).toThrow(
      databaseModule.DatabaseConfigurationError
    );
  });

  it("marks the database modules as server-only", () => {
    for (const file of [
      resolve(process.cwd(), "src/db/client.ts"),
      resolve(process.cwd(), "src/db/auth-accounts.ts"),
      resolve(process.cwd(), "src/db/usage-limits.ts"),
    ]) {
      expect(readFileSync(file, "utf8")).toContain('import "server-only"');
    }
  });

  it("does not import database modules from Client Components", () => {
    const appDirectory = resolve(process.cwd(), "src/app");
    const clientFiles = sourceFiles(appDirectory).filter((file) => {
      if (!/\.tsx?$/.test(file)) return false;
      return /^\s*["']use client["'];/m.test(readFileSync(file, "utf8"));
    });

    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']@\/db\//);
      expect(source).not.toContain("process.env.DATABASE_URL");
      expect(source).not.toContain("process.env.DIRECT_DATABASE_URL");
    }
  });

  it("does not define public database environment variables", () => {
    const example = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");

    expect(example).toContain("DATABASE_URL=");
    expect(example).toContain("DIRECT_DATABASE_URL=");
    expect(example).not.toContain("NEXT_PUBLIC_DATABASE");
    expect(example).not.toMatch(/postgres(?:ql)?:\/\//);
  });
});
