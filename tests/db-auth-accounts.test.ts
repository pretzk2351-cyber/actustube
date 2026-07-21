import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGoogleAccountUpsertQuery,
  GoogleAccountPersistenceError,
  InvalidGoogleAccountError,
  syncGoogleAccountWithDatabase,
} from "@/db/auth-accounts";
import { buildGoogleAccountSyncDiagnostic } from "@/db/auth-db-error-diagnostic";

const INTERNAL_USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google account persistence", () => {
  it("upserts by provider and providerAccountId and returns the internal user", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async () => ({
      rows: [
        {
          userId: INTERNAL_USER_ID,
          status: "active",
          sessionVersion: 1,
        },
      ],
    }));

    const result = await syncGoogleAccountWithDatabase(
      { execute } as never,
      {
        providerAccountId: "google-account-123",
        email: "user@example.test",
        name: "Test User",
        imageUrl: "https://example.test/avatar.png",
        grantedScope: "openid email profile youtube.readonly",
      },
      new Date("2026-07-17T00:00:00.000Z")
    );

    expect(result).toEqual({
      userId: INTERNAL_USER_ID,
      status: "active",
      sessionVersion: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("builds an idempotent SQL upsert without OAuth token columns", () => {
    const query = buildGoogleAccountUpsertQuery({
      providerAccountId: "google-account-123",
      grantedScope: "youtube.readonly",
    });
    const built = new PgDialect().sqlToQuery(query);
    const normalizedSql = built.sql.toLowerCase();

    expect(normalizedSql).toContain('"sync_google_oauth_account"');
    expect(normalizedSql).toContain('"user_id" as "userid"');
    expect(normalizedSql).toContain('"account_status" as "status"');
    expect(normalizedSql).toContain('"session_version" as "sessionversion"');
    expect(built.params).toContain("google-account-123");
    expect(normalizedSql).not.toContain("access_token");
    expect(normalizedSql).not.toContain("refresh_token");
    expect(normalizedSql).not.toContain("client_secret");
  });

  it("rejects an empty provider account ID before database access", async () => {
    const execute = vi.fn();

    await expect(
      syncGoogleAccountWithDatabase(
        { execute } as never,
        { providerAccountId: "   " }
      )
    ).rejects.toBeInstanceOf(InvalidGoogleAccountError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not emit a database diagnostic for an invalid successful result", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      syncGoogleAccountWithDatabase(
        { execute } as never,
        { providerAccountId: "google-account-123" }
      )
    ).rejects.toBeInstanceOf(GoogleAccountPersistenceError);

    expect(errorLog).not.toHaveBeenCalled();
  });

  it("logs only allowlisted sanitized fields and rethrows the original database error", async () => {
    const sourceCause = Object.assign(new Error("socket closed"), {
      name: "SocketError",
      code: "ECONNRESET",
      stack: "must-not-be-logged-source-cause-stack",
    });
    const sourceError = Object.assign(new Error("fetch failed"), {
      name: "TypeError",
      code: "UND_ERR_CONNECT_TIMEOUT",
      cause: sourceCause,
      stack: "must-not-be-logged-source-stack",
    });
    const neonError = Object.assign(
      new Error(
        "Connection failed for person@example.test at postgresql://db-user:db-password@ep-example.neon.tech/neondb image URL: https://example.test/private-avatar.png"
      ),
      {
        name: "NeonDbError",
        code: "08006",
        severity: "ERROR",
        detail:
          "Key (provider_account_id)=(123456789012345678901) belongs to user TestPerson",
        hint:
          "Authorization: Bearer ya29.must-not-appear; Cookie: session=private-cookie; Client ID: private-client-id; Client Secret: private-client-secret; access token: private-access-token; refresh_token=private-refresh-token; ID token: private-id-token",
        where: "query: SELECT secret FROM users params: must-not-appear",
        schema: "public",
        table: "oauth_accounts",
        column: "provider_account_id",
        constraint: "oauth_accounts_provider_provider_account_id_unique",
        routine: "ConnectionFailure",
        sourceError,
        stack: "must-not-be-logged-neon-stack",
        internalQuery: "must-not-be-logged-query",
        parameters: ["must-not-be-logged-params"],
      }
    );
    const drizzleError = Object.assign(new Error("Failed query: hidden"), {
      cause: neonError,
      query: "must-not-be-logged-outer-query",
      params: ["must-not-be-logged-outer-param"],
      stack: "must-not-be-logged-outer-stack",
    });
    const execute = vi.fn().mockRejectedValue(drizzleError);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      syncGoogleAccountWithDatabase(
        { execute } as never,
        { providerAccountId: "google-account-123" }
      )
    ).rejects.toBe(drizzleError);

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe(
      "[auth][google-account-sync-diagnostic]"
    );
    const diagnostic = errorLog.mock.calls[0]?.[1];
    expect(diagnostic).toEqual({
      error: { name: "Error" },
      neonDbError: {
        name: "NeonDbError",
        message: expect.any(String),
        code: "08006",
        severity: "ERROR",
        detail: expect.any(String),
        hint: expect.any(String),
        where: null,
        schema: "public",
        table: "oauth_accounts",
        column: "provider_account_id",
        constraint: "oauth_accounts_provider_provider_account_id_unique",
        routine: "ConnectionFailure",
        sourceError: {
          name: "TypeError",
          code: "UND_ERR_CONNECT_TIMEOUT",
          cause: { name: "SocketError", code: "ECONNRESET" },
        },
      },
    });

    const serialized = JSON.stringify(diagnostic);
    for (const sensitiveValue of [
      "person@example.test",
      "123456789012345678901",
      "TestPerson",
      "ya29.must-not-appear",
      `postgres${"ql://"}`,
      "db-password",
      "private-avatar",
      "private-cookie",
      "private-client-id",
      "private-client-secret",
      "private-access-token",
      "private-refresh-token",
      "private-id-token",
      "must-not-be-logged",
      "SELECT secret",
    ]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("internalQuery");
    expect(serialized).not.toContain("parameters");
  });

  it("rethrows the original database error when diagnostic logging fails", async () => {
    const databaseError = new Error("database unavailable");
    const execute = vi.fn().mockRejectedValue(databaseError);
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("logger unavailable");
    });

    await expect(
      syncGoogleAccountWithDatabase(
        { execute } as never,
        { providerAccountId: "google-account-123" }
      )
    ).rejects.toBe(databaseError);
  });

  it("normalizes missing nested errors to null without throwing", () => {
    expect(buildGoogleAccountSyncDiagnostic(new Error("database unavailable")))
      .toEqual({
        error: { name: "Error" },
        neonDbError: {
          name: null,
          message: null,
          code: null,
          severity: null,
          detail: null,
          hint: null,
          where: null,
          schema: null,
          table: null,
          column: null,
          constraint: null,
          routine: null,
          sourceError: {
            name: null,
            code: null,
            cause: { name: null, code: null },
          },
        },
      });
  });

  it("stops on circular references", () => {
    const circular = Object.assign(new Error("database unavailable"), {
      cause: null as unknown,
    });
    circular.cause = circular;

    expect(buildGoogleAccountSyncDiagnostic(circular).neonDbError.name).toBeNull();
  });

  it("does not inspect beyond the maximum nested error depth", () => {
    const tooDeepNeonError = Object.assign(new Error("too deep"), {
      name: "NeonDbError",
    });
    const levelFive = { name: "LevelFive", cause: tooDeepNeonError };
    const levelFour = { name: "LevelFour", cause: levelFive };
    const levelThree = { name: "LevelThree", cause: levelFour };
    const levelTwo = { name: "LevelTwo", cause: levelThree };
    const levelOne = { name: "LevelOne", cause: levelTwo };
    const root = { name: "RootError", cause: levelOne };

    expect(buildGoogleAccountSyncDiagnostic(root).neonDbError.name).toBeNull();
  });

  it("limits diagnostic text length", () => {
    const neonError = Object.assign(
      new Error(`fetch failed ${"safe-word ".repeat(100)}`),
      { name: "NeonDbError" }
    );

    const message = buildGoogleAccountSyncDiagnostic(neonError).neonDbError
      .message;
    expect(message).toHaveLength(512);
    expect(message?.endsWith("…")).toBe(true);
  });
});
