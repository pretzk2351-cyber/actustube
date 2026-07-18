import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildFinalizeUsageReservationQuery,
  buildReleaseUsageQuery,
  buildUsageReservationQuery,
  finalizeUsageReservationWithDatabase,
  InvalidUsageReservationInputError,
  releaseUsageReservationWithDatabase,
  reserveUsageWithDatabase,
  UsageReservationLifecyclePersistenceError,
  UsageReservationPersistenceError,
  type UsageDenialReason,
  type UsageMetric,
} from "@/db/usage-limits";

const INTERNAL_USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";
const RESERVATION_ID = "a95fa157-5f30-42ca-97ea-d7ba4f23f331";

function reservationRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    allowed: true,
    denialReason: null,
    reservationId: RESERVATION_ID,
    metric: "channel_analysis",
    dailyUsed: 1,
    dailyLimit: 2,
    dailyResetAt: "2026-07-19T00:00:00.000Z",
    monthlyUsed: 1,
    monthlyLimit: 5,
    monthlyResetAt: "2026-08-01T00:00:00.000Z",
    planCode: "free",
    ...overrides,
  };
}

function databaseReturning(row: Record<string, unknown>) {
  return {
    execute: vi.fn(async () => ({ rows: [row] })),
  };
}

describe("usage reservation", () => {
  it.each([
    {
      metric: "channel_analysis" as const,
      dailyLimit: 2,
      monthlyLimit: 5,
    },
    { metric: "ai_consult" as const, dailyLimit: 1, monthlyLimit: 3 },
  ])(
    "returns the DB-owned free limits for $metric",
    async ({ metric, dailyLimit, monthlyLimit }) => {
      const database = databaseReturning(
        reservationRow({ metric, dailyLimit, monthlyLimit })
      );

      const result = await reserveUsageWithDatabase(database as never, {
        userId: INTERNAL_USER_ID,
        sessionVersion: 1,
        metric,
      });

      expect(result).toMatchObject({
        allowed: true,
        denialReason: null,
        metric,
        dailyUsed: 1,
        dailyLimit,
        monthlyUsed: 1,
        monthlyLimit,
        planCode: "free",
      });
      expect(result.dailyResetAt.toISOString()).toBe(
        "2026-07-19T00:00:00.000Z"
      );
      expect(result.monthlyResetAt.toISOString()).toBe(
        "2026-08-01T00:00:00.000Z"
      );
    }
  );

  it.each<{
    reason: UsageDenialReason;
    metric: UsageMetric;
  }>([
    { reason: "user_not_found", metric: "channel_analysis" },
    { reason: "user_inactive", metric: "channel_analysis" },
    { reason: "session_version_mismatch", metric: "channel_analysis" },
    { reason: "no_active_plan", metric: "ai_consult" },
    { reason: "daily_limit_reached", metric: "channel_analysis" },
    { reason: "monthly_limit_reached", metric: "ai_consult" },
  ])("preserves the internal denial reason $reason", async ({ reason, metric }) => {
    const hasPlan = reason.endsWith("limit_reached");
    const database = databaseReturning(
      reservationRow({
        allowed: false,
        denialReason: reason,
        reservationId: null,
        metric,
        dailyUsed: hasPlan ? 2 : null,
        dailyLimit: hasPlan ? 2 : null,
        monthlyUsed: hasPlan ? 3 : null,
        monthlyLimit: hasPlan ? 5 : null,
        planCode: hasPlan ? "free" : null,
      })
    );

    const result = await reserveUsageWithDatabase(database as never, {
      userId: INTERNAL_USER_ID,
      sessionVersion: 1,
      metric,
    });

    expect(result.allowed).toBe(false);
    expect(result.denialReason).toBe(reason);
  });

  it("sends only the internal user ID, session version, and metric to PostgreSQL", () => {
    const query = buildUsageReservationQuery({
      userId: INTERNAL_USER_ID,
      sessionVersion: 7,
      metric: "channel_analysis",
      planCode: "untrusted-paid-plan",
      dailyLimit: 999_999,
      monthlyLimit: 999_999,
    } as never);
    const built = new PgDialect().sqlToQuery(query);
    const serialized = JSON.stringify(built);

    expect(built.params).toEqual([
      INTERNAL_USER_ID,
      7,
      "channel_analysis",
    ]);
    expect(built.sql).toContain('"public"."reserve_usage_limits"');
    expect(serialized).not.toContain("untrusted-paid-plan");
    expect(serialized).not.toContain("999999");
  });

  it.each([
    { userId: "not-a-uuid", sessionVersion: 1, metric: "channel_analysis" },
    { userId: INTERNAL_USER_ID, sessionVersion: 0, metric: "channel_analysis" },
    { userId: INTERNAL_USER_ID, sessionVersion: 1, metric: "untrusted_metric" },
  ])("rejects invalid server-side reservation input", async (input) => {
    const database = databaseReturning(reservationRow());

    await expect(
      reserveUsageWithDatabase(database as never, input as never)
    ).rejects.toBeInstanceOf(InvalidUsageReservationInputError);
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("sanitizes database failures", async () => {
    const database = {
      execute: vi.fn(async () => {
        throw new Error(
          "postgresql://database-user:database-secret@example.test/database"
        );
      }),
    };

    let failure: unknown;
    try {
      await reserveUsageWithDatabase(database as never, {
        userId: INTERNAL_USER_ID,
        sessionVersion: 1,
        metric: "channel_analysis",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UsageReservationPersistenceError);
    expect(String(failure)).toBe(
      "UsageReservationPersistenceError: Usage reservation could not be completed."
    );
    expect(String(failure)).not.toContain("database-secret");
    expect(String(failure)).not.toContain("postgresql://");
  });

  it("builds release and finalize queries from only server-owned identifiers", () => {
    const release = new PgDialect().sqlToQuery(
      buildReleaseUsageQuery({
        reservationId: RESERVATION_ID,
        userId: INTERNAL_USER_ID,
      })
    );
    const finalize = new PgDialect().sqlToQuery(
      buildFinalizeUsageReservationQuery({
        reservationId: RESERVATION_ID,
        userId: INTERNAL_USER_ID,
      })
    );

    expect(release.params).toEqual([RESERVATION_ID, INTERNAL_USER_ID]);
    expect(release.sql).toContain('"public"."release_usage_limits"');
    expect(finalize.params).toEqual([RESERVATION_ID, INTERNAL_USER_ID]);
    expect(finalize.sql).toContain(
      '"public"."finalize_usage_reservation"'
    );
  });

  it("parses one-time release and already-consumed release results", async () => {
    const released = await releaseUsageReservationWithDatabase(
      databaseReturning({ released: true, dailyUsed: 0, monthlyUsed: 0 }) as never,
      { reservationId: RESERVATION_ID, userId: INTERNAL_USER_ID }
    );
    const alreadyConsumed = await releaseUsageReservationWithDatabase(
      databaseReturning({
        released: false,
        dailyUsed: null,
        monthlyUsed: null,
      }) as never,
      { reservationId: RESERVATION_ID, userId: INTERNAL_USER_ID }
    );

    expect(released).toEqual({ released: true, dailyUsed: 0, monthlyUsed: 0 });
    expect(alreadyConsumed).toEqual({
      released: false,
      dailyUsed: null,
      monthlyUsed: null,
    });
  });

  it("parses successful and missing finalization results", async () => {
    await expect(
      finalizeUsageReservationWithDatabase(
        databaseReturning({ finalized: true }) as never,
        { reservationId: RESERVATION_ID, userId: INTERNAL_USER_ID }
      )
    ).resolves.toBe(true);
    await expect(
      finalizeUsageReservationWithDatabase(
        databaseReturning({ finalized: false }) as never,
        { reservationId: RESERVATION_ID, userId: INTERNAL_USER_ID }
      )
    ).resolves.toBe(false);
  });

  it("sanitizes release database failures", async () => {
    const database = {
      execute: vi.fn(async () => {
        throw new Error("postgresql://user:database-secret@example.test/db");
      }),
    };

    let failure: unknown;
    try {
      await releaseUsageReservationWithDatabase(database as never, {
        reservationId: RESERVATION_ID,
        userId: INTERNAL_USER_ID,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(
      UsageReservationLifecyclePersistenceError
    );
    expect(String(failure)).not.toContain("database-secret");
    expect(String(failure)).not.toContain("postgresql://");
  });
});
