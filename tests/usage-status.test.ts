import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildUsageStatusQuery,
  getUsageStatusWithDatabase,
  InvalidUsageStatusInputError,
  UsageStatusPersistenceError,
} from "@/db/usage-status";

const INTERNAL_USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";

function availableRow(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    denialReason: null,
    effectivePlanId: "free",
    canonicalPlanKey: "free",
    planKind: "free",
    planFromAssignment: false,
    analysisDailyUsed: 0,
    analysisDailyLimit: 2,
    analysisDailyRemaining: 2,
    analysisDailyResetAt: "2026-07-25T00:00:00.000Z",
    analysisMonthlyUsed: 0,
    analysisMonthlyLimit: 5,
    analysisMonthlyRemaining: 5,
    analysisMonthlyResetAt: "2026-08-01T00:00:00.000Z",
    aiDailyUsed: 0,
    aiDailyLimit: 1,
    aiDailyRemaining: 1,
    aiDailyResetAt: "2026-07-25T00:00:00.000Z",
    aiMonthlyUsed: 0,
    aiMonthlyLimit: 3,
    aiMonthlyRemaining: 3,
    aiMonthlyResetAt: "2026-08-01T00:00:00.000Z",
    regularVideoLimit: 10,
    shortsVideoLimit: 10,
    ...overrides,
  };
}

function databaseReturning(row: Record<string, unknown>) {
  return {
    execute: vi.fn(async () => ({ rows: [row] })),
  };
}

describe("usage status", () => {
  it.each([
    { planFromAssignment: false, source: "free_fallback" },
    { planFromAssignment: true, source: "assignment" },
  ] as const)(
    "returns a server-owned $source plan snapshot without reserving usage",
    async ({ planFromAssignment, source }) => {
      const database = databaseReturning(
        availableRow({ planFromAssignment })
      );

      const result = await getUsageStatusWithDatabase(database as never, {
        userId: INTERNAL_USER_ID,
        sessionVersion: 7,
      });

      expect(result).toMatchObject({
        available: true,
        plan: {
          effectivePlanId: "free",
          canonicalPlanKey: "free",
          kind: "free",
          source,
          regularVideoLimit: 10,
          shortsVideoLimit: 10,
        },
        channelAnalysis: {
          daily: { used: 0, limit: 2, remaining: 2 },
          monthly: { used: 0, limit: 5, remaining: 5 },
        },
        aiConsult: {
          daily: { used: 0, limit: 1, remaining: 1 },
          monthly: { used: 0, limit: 3, remaining: 3 },
        },
      });
    }
  );

  it("sends only the authenticated internal identity to the read-only function", () => {
    const query = buildUsageStatusQuery({
      userId: INTERNAL_USER_ID,
      sessionVersion: 7,
      plan: "untrusted-paid-plan",
      quota: 999_999,
    } as never);
    const built = new PgDialect().sqlToQuery(query);
    const serialized = JSON.stringify(built);

    expect(built.params).toEqual([INTERNAL_USER_ID, 7]);
    expect(built.sql).toContain('"public"."get_usage_status_v1"');
    expect(serialized).not.toContain("untrusted-paid-plan");
    expect(serialized).not.toContain("999999");
    expect(built.sql).not.toMatch(/reserve|recover|insert|update|delete/i);
  });

  it.each([
    "user_not_found",
    "user_inactive",
    "session_version_mismatch",
  ] as const)("preserves the safe denial reason %s", async (denialReason) => {
    const database = databaseReturning({ available: false, denialReason });

    await expect(
      getUsageStatusWithDatabase(database as never, {
        userId: INTERNAL_USER_ID,
        sessionVersion: 1,
      })
    ).resolves.toEqual({ available: false, denialReason });
  });

  it.each([
    { effectivePlanId: "free", canonicalPlanKey: "other" },
    { planKind: "paid" },
    { regularVideoLimit: -1 },
  ])("fails closed for an inconsistent result", async (override) => {
    const database = databaseReturning(availableRow(override));

    await expect(
      getUsageStatusWithDatabase(database as never, {
        userId: INTERNAL_USER_ID,
        sessionVersion: 1,
      })
    ).rejects.toBeInstanceOf(UsageStatusPersistenceError);
  });

  it("accepts a zero-clamped remaining value when legacy usage exceeds the limit", async () => {
    const database = databaseReturning(
      availableRow({ analysisDailyUsed: 3, analysisDailyRemaining: 0 })
    );

    const result = await getUsageStatusWithDatabase(database as never, {
      userId: INTERNAL_USER_ID,
      sessionVersion: 1,
    });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.channelAnalysis.daily).toMatchObject({
        used: 3,
        limit: 2,
        remaining: 0,
      });
    }
  });

  it.each([
    { userId: "not-a-uuid", sessionVersion: 1 },
    { userId: INTERNAL_USER_ID, sessionVersion: 0 },
  ])("rejects invalid server identity before querying", async (input) => {
    const database = databaseReturning(availableRow());

    await expect(
      getUsageStatusWithDatabase(database as never, input)
    ).rejects.toBeInstanceOf(InvalidUsageStatusInputError);
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("sanitizes database errors", async () => {
    const database = {
      execute: vi.fn(async () => {
        throw new Error(
          "postgresql://database-user:database-secret@example.test/database"
        );
      }),
    };

    let failure: unknown;
    try {
      await getUsageStatusWithDatabase(database as never, {
        userId: INTERNAL_USER_ID,
        sessionVersion: 1,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UsageStatusPersistenceError);
    expect(String(failure)).toBe(
      "UsageStatusPersistenceError: Usage status could not be loaded."
    );
    expect(String(failure)).not.toContain("database-secret");
    expect(String(failure)).not.toContain("postgresql://");
  });
});
