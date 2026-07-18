import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildGoogleAccountUpsertQuery,
  InvalidGoogleAccountError,
  syncGoogleAccountWithDatabase,
} from "@/db/auth-accounts";

const INTERNAL_USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";

describe("Google account persistence", () => {
  it("upserts by provider and providerAccountId and returns the internal user", async () => {
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
  });

  it("builds an idempotent SQL upsert without OAuth token columns", () => {
    const query = buildGoogleAccountUpsertQuery({
      providerAccountId: "google-account-123",
      grantedScope: "youtube.readonly",
    });
    const built = new PgDialect().sqlToQuery(query);
    const normalizedSql = built.sql.toLowerCase();

    expect(normalizedSql).toContain('"sync_google_oauth_account"');
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
});
