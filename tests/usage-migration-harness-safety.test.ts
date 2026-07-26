import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSanitizedEnvironment,
  isSafeHarnessTemporaryPath,
  sanitizeDiagnostic,
} from "../scripts/usage-migration-harness-safety.mjs";

describe("local migration harness safety", () => {
  it("passes only explicitly allowed non-secret environment values", () => {
    const sanitized = createSanitizedEnvironment({
      PATH: "safe-path",
      TEMP: "safe-temp",
      DATABASE_URL: "must-not-pass",
      DIRECT_DATABASE_URL: "must-not-pass",
      VERCEL_TOKEN: "must-not-pass",
      CI: "true",
    });

    expect(sanitized).toEqual({ PATH: "safe-path", TEMP: "safe-temp" });
  });

  it("redacts connection strings and secret-shaped settings", () => {
    const sanitized = sanitizeDiagnostic(
      "DATABASE_URL=postgresql://user:password@example.invalid/db"
    );

    expect(sanitized).not.toContain("user:password");
    expect(sanitized).not.toContain("example.invalid");
  });

  it.each([
    ["Windows", String.raw`C:\Users\windows-person\private\file.txt`, "windows-person"],
    ["macOS", "/Users/mac-person/private/file.txt", "mac-person"],
    ["Linux", "/home/linux-person/private/file.txt", "linux-person"],
  ])("redacts %s user paths", (_platform, userPath, username) => {
    const sanitized = sanitizeDiagnostic(userPath);

    expect(sanitized).toContain("[redacted-path]");
    expect(sanitized).not.toContain(username);
  });

  it("accepts only an owned uniquely-prefixed temporary child path", () => {
    const root = join("C:", "safe-temp");

    expect(
      isSafeHarnessTemporaryPath(join(root, "actustube-pg-owned"), root)
    ).toBe(true);
    expect(isSafeHarnessTemporaryPath(join(root, "unrelated"), root)).toBe(
      false
    );
    expect(
      isSafeHarnessTemporaryPath(
        join(root, "..", "actustube-pg-outside"),
        root
      )
    ).toBe(false);
  });
});
