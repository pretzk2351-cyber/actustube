import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { FREE_PLAN } from "@/db/free-plan";
import {
  oauthAccounts,
  plans,
  userPlanAssignments,
  users,
  userUsageBuckets,
} from "@/db/schema";

function initialMigrationSql() {
  const migrationDirectory = resolve(process.cwd(), "drizzle");
  const migration = readdirSync(migrationDirectory).find((file) =>
    /^0000_.*\.sql$/.test(file)
  );
  if (!migration) throw new Error("Initial migration was not generated.");
  return readFileSync(resolve(migrationDirectory, migration), "utf8");
}

describe("database schema", () => {
  it("defines all five stage-one tables", () => {
    expect([
      getTableConfig(users).name,
      getTableConfig(oauthAccounts).name,
      getTableConfig(plans).name,
      getTableConfig(userPlanAssignments).name,
      getTableConfig(userUsageBuckets).name,
    ]).toEqual([
      "users",
      "oauth_accounts",
      "plans",
      "user_plan_assignments",
      "user_usage_buckets",
    ]);
  });

  it("generates the required unique constraints and foreign keys", () => {
    const sql = initialMigrationSql();

    expect(sql).toContain(
      'CREATE UNIQUE INDEX "oauth_accounts_provider_account_unique"'
    );
    expect(sql).toContain('("provider","provider_account_id")');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "user_usage_buckets_scope_unique"'
    );
    expect(sql).toContain(
      '("user_id","metric","period_kind","period_start")'
    );
    expect(sql).toContain("FOREIGN KEY");
    expect(sql).toContain("ON DELETE cascade");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "user_plan_assignments_one_active_per_user"'
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "public"."sync_google_oauth_account"'
    );
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("IF v_user_id IS NULL THEN");
    expect(sql).toContain("UPDATE public.oauth_accounts");
  });

  it("keeps OAuth secrets out of the database schema and migration", () => {
    const serializedSchema = JSON.stringify(
      getTableConfig(oauthAccounts).columns.map((column) => column.name)
    );
    const sql = initialMigrationSql();

    for (const forbidden of [
      "access_token",
      "refresh_token",
      "client_secret",
    ]) {
      expect(serializedSchema).not.toContain(forbidden);
      expect(sql).not.toContain(forbidden);
    }
  });

  it("defines the approved free plan values", () => {
    expect(FREE_PLAN).toEqual({
      code: "free",
      name: "Free",
      analysisDailyLimit: 2,
      analysisMonthlyLimit: 5,
      aiDailyLimit: 1,
      aiMonthlyLimit: 3,
      regularVideoLimit: 10,
      shortsVideoLimit: 10,
      historyRetentionDays: 90,
      active: true,
    });
  });

  it("seeds the free plan idempotently in the initial migration", () => {
    const sql = initialMigrationSql();

    expect(sql).toContain(
      "VALUES ('free', 'Free', 2, 5, 1, 3, 10, 10, 90, true)"
    );
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE');
  });
});
