import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { FREE_PLAN } from "@/db/free-plan";
import {
  oauthAccounts,
  plans,
  usageReservationLeases,
  usageMetricEnum,
  userPlanAssignments,
  users,
  userUsageBuckets,
} from "@/db/schema";

function migrationSql(index: number) {
  const migrationDirectory = resolve(process.cwd(), "drizzle");
  const migration = readdirSync(migrationDirectory).find((file) =>
    new RegExp(`^${String(index).padStart(4, "0")}_.*\\.sql$`).test(file)
  );
  if (!migration) throw new Error(`Migration ${index} was not generated.`);
  return readFileSync(resolve(migrationDirectory, migration), "utf8");
}

function initialMigrationSql() {
  return migrationSql(0);
}

function conflictFixMigrationSql() {
  return migrationSql(1);
}

function usageReservationMigrationSql() {
  return migrationSql(2);
}

function usageReleaseMigrationSql() {
  return migrationSql(3);
}

describe("database schema", () => {
  it("defines the five foundation tables and the internal reservation lease table", () => {
    expect([
      getTableConfig(users).name,
      getTableConfig(oauthAccounts).name,
      getTableConfig(plans).name,
      getTableConfig(userPlanAssignments).name,
      getTableConfig(userUsageBuckets).name,
      getTableConfig(usageReservationLeases).name,
    ]).toEqual([
      "users",
      "oauth_accounts",
      "plans",
      "user_plan_assignments",
      "user_usage_buckets",
      "usage_reservation_leases",
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
    const sql = [
      initialMigrationSql(),
      conflictFixMigrationSql(),
      usageReservationMigrationSql(),
      usageReleaseMigrationSql(),
    ].join("\n");

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

  it("keeps all three applied migrations unchanged", () => {
    const hashes = [
      initialMigrationSql(),
      conflictFixMigrationSql(),
      usageReservationMigrationSql(),
    ].map(
      (migration) =>
        createHash("sha256")
          .update(migration.replaceAll("\r\n", "\n"))
          .digest("hex")
    );

    expect(hashes).toEqual([
      "9bc21d6a4f264ae7e77d790a19cc3165b18c694f02c2c6d7ccdb0d066f36b368",
      "daff8ea267f0bfbc010ae3f09f888b901b6c9d1d887069bf78e6adff924d0a7e",
      "123418538b6aef85a0d4f105792334835e289954ee980c985385cd1107daa4ce",
    ]);
  });

  it("resolves the function-local ON CONFLICT ambiguity without changing its return contract", () => {
    const sql = conflictFixMigrationSql();
    const directivePosition = sql.indexOf("#variable_conflict use_column");
    const conflictPosition = sql.indexOf(
      "ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING"
    );

    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "public"."sync_google_oauth_account"'
    );
    expect(directivePosition).toBeGreaterThan(-1);
    expect(conflictPosition).toBeGreaterThan(directivePosition);
    expect(sql).toContain(`RETURNS TABLE (
\t"user_id" uuid,
\t"account_status" "public"."user_status",
\t"session_version" integer
)`);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP) TABLE\b/i);
    expect(sql).not.toMatch(/\b(?:CREATE|DROP) INDEX\b/i);
  });

  it("keeps use_column from changing other PL/pgSQL references", () => {
    const sql = conflictFixMigrationSql();

    expect(sql).toContain("SELECT oa.user_id");
    expect(sql).toContain("WHERE oa.provider = 'google'");
    expect(sql).toContain("AND oa.provider_account_id = p_provider_account_id");
    expect(sql).toContain("WHERE active_user.id = v_user_id");
    expect(sql).toContain("AND active_user.status = 'active'");
    expect(sql).toContain("SELECT u.id, u.status, u.session_version");
    expect(sql).toContain("WHERE u.id = v_user_id");
  });

  it("preserves one idempotent active free-plan assignment per user", () => {
    const initialSql = initialMigrationSql();
    const fixSql = conflictFixMigrationSql();

    expect(initialSql).toContain(
      'CREATE UNIQUE INDEX "user_plan_assignments_one_active_per_user"'
    );
    expect(initialSql).toContain(
      'ON "user_plan_assignments" USING btree ("user_id") WHERE "user_plan_assignments"."status" = \'active\''
    );
    expect(fixSql.match(/INSERT INTO public\.users/g)).toHaveLength(1);
    expect(fixSql.match(/INSERT INTO public\.oauth_accounts/g)).toHaveLength(1);
    expect(fixSql.match(/INSERT INTO public\.user_plan_assignments/g)).toHaveLength(
      1
    );
    expect(fixSql).toContain(`SELECT
\t\tv_user_id,
\t\t'free',
\t\t'active',
\t\t'system'`);
    expect(fixSql).toContain(
      "ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING"
    );
  });

  it("defines only the two approved usage metrics and free limits", () => {
    const sql = usageReservationMigrationSql();
    const snapshot = readFileSync(
      resolve(process.cwd(), "drizzle/meta/0002_snapshot.json"),
      "utf8"
    );

    expect(usageMetricEnum.enumValues).toEqual([
      "channel_analysis",
      "ai_consult",
    ]);
    expect(sql).toContain(
      `ALTER TYPE "public"."usage_metric" RENAME VALUE 'analysis' TO 'channel_analysis'`
    );
    expect(snapshot).toContain('"channel_analysis"');
    expect(snapshot).not.toMatch(/^\s*"analysis",?$/m);
    expect(sql).toContain(
      "WHEN 'channel_analysis' THEN p.analysis_daily_limit"
    );
    expect(sql).toContain(
      "WHEN 'channel_analysis' THEN p.analysis_monthly_limit"
    );
    expect(sql).toContain("WHEN 'ai_consult' THEN p.ai_daily_limit");
    expect(sql).toContain("WHEN 'ai_consult' THEN p.ai_monthly_limit");
    expect(FREE_PLAN.analysisDailyLimit).toBe(2);
    expect(FREE_PLAN.analysisMonthlyLimit).toBe(5);
    expect(FREE_PLAN.aiDailyLimit).toBe(1);
    expect(FREE_PLAN.aiMonthlyLimit).toBe(3);
  });

  it("calculates day and month periods explicitly in UTC", () => {
    const sql = usageReservationMigrationSql();

    expect(sql).toContain(
      "date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    );
    expect(sql).toContain(
      "date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    );
    expect(sql).toContain("v_daily_start + interval '1 day'");
    expect(sql).toContain("v_monthly_start + interval '1 month'");
  });

  it("keeps user, session, and active-plan validation inside PostgreSQL", () => {
    const sql = usageReservationMigrationSql();

    expect(sql).toContain("FROM public.users AS u");
    expect(sql).toContain("WHERE u.id = p_user_id");
    expect(sql).toContain("IF v_user_status <> 'active' THEN");
    expect(sql).toContain(
      "IF v_database_session_version <> p_session_version THEN"
    );
    expect(sql).toContain("FROM public.user_plan_assignments AS upa");
    expect(sql).toContain(
      "INNER JOIN public.plans AS p ON p.code = upa.plan_code"
    );
    expect(sql).toContain("AND upa.status = 'active'");
    expect(sql).toContain("AND upa.starts_at <= v_now");
    expect(sql).toContain(
      "AND (upa.ends_at IS NULL OR upa.ends_at > v_now)"
    );
    expect(sql).toContain("AND p.active = true");
  });

  it("reserves daily and monthly buckets atomically under one advisory lock", () => {
    const sql = usageReservationMigrationSql();
    const dailyDenial = sql.indexOf("IF v_daily_used >= v_daily_limit THEN");
    const monthlyDenial = sql.indexOf(
      "IF v_monthly_used >= v_monthly_limit THEN"
    );
    const dailyWrite = sql.indexOf(
      "INSERT INTO public.user_usage_buckets AS daily_bucket"
    );
    const monthlyWrite = sql.indexOf(
      "INSERT INTO public.user_usage_buckets AS monthly_bucket"
    );

    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain(
      "'usage:' || p_user_id::text || ':' || p_metric::text"
    );
    expect(dailyDenial).toBeGreaterThan(-1);
    expect(monthlyDenial).toBeGreaterThan(dailyDenial);
    expect(dailyWrite).toBeGreaterThan(monthlyDenial);
    expect(monthlyWrite).toBeGreaterThan(dailyWrite);
    expect(sql.match(/ON CONFLICT \(user_id, metric, period_kind, period_start\)/g)).toHaveLength(
      2
    );
    expect(sql).toContain("limit_snapshot = EXCLUDED.limit_snapshot");
  });

  it("keeps the reservation function scoped and unambiguous", () => {
    const sql = usageReservationMigrationSql();
    const directivePosition = sql.indexOf("#variable_conflict use_column");
    const firstConflictPosition = sql.indexOf(
      "ON CONFLICT (user_id, metric, period_kind, period_start)"
    );

    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain("SET search_path = public, pg_temp");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "public"."reserve_usage_limits"'
    );
    expect(directivePosition).toBeGreaterThan(-1);
    expect(firstConflictPosition).toBeGreaterThan(directivePosition);
    expect(sql).not.toMatch(/https?:\/\//);
    expect(sql).not.toMatch(/\b(?:email|provider_account_id|access_token)\b/i);
  });

  it("adds one-time reservation leases without changing usage bucket limits", () => {
    const sql = usageReleaseMigrationSql();
    const table = getTableConfig(usageReservationLeases);

    expect(table.name).toBe("usage_reservation_leases");
    expect(table.columns.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "metric",
      "daily_period_start",
      "monthly_period_start",
      "created_at",
    ]);
    expect(sql).toContain('CREATE TABLE "usage_reservation_leases"');
    expect(sql).toContain("ON DELETE cascade");
    expect(sql).toContain('"reservation_id" uuid');
    expect(sql).not.toMatch(/ALTER TABLE "user_usage_buckets"/);
    expect(sql).not.toMatch(/ALTER TABLE "plans"/);
  });

  it("preserves all stage-two checks in the recreated reservation function", () => {
    const sql = usageReleaseMigrationSql();

    expect(sql).toContain(
      "date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    );
    expect(sql).toContain(
      "date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    );
    expect(sql).toContain("FROM public.users AS u");
    expect(sql).toContain("IF v_user_status <> 'active' THEN");
    expect(sql).toContain(
      "IF v_database_session_version <> p_session_version THEN"
    );
    expect(sql).toContain("FROM public.user_plan_assignments AS upa");
    expect(sql).toContain("AND upa.starts_at <= v_now");
    expect(sql).toContain(
      "AND (upa.ends_at IS NULL OR upa.ends_at > v_now)"
    );
    expect(sql).toContain("AND p.active = true");
    expect(sql).toContain("IF v_daily_used >= v_daily_limit THEN");
    expect(sql).toContain("IF v_monthly_used >= v_monthly_limit THEN");
    expect(
      sql.match(
        /ON CONFLICT \(user_id, metric, period_kind, period_start\)/g
      )
    ).toHaveLength(2);
    expect(sql).toContain(
      "'usage:' || p_user_id::text || ':' || p_metric::text"
    );
  });

  it("releases daily and monthly usage atomically and only once", () => {
    const sql = usageReleaseMigrationSql();
    const releaseStart = sql.indexOf(
      'CREATE FUNCTION "public"."release_usage_limits"'
    );
    const releaseSql = sql.slice(releaseStart);

    expect(releaseStart).toBeGreaterThan(-1);
    expect(releaseSql).toContain("FOR UPDATE OF r");
    expect(releaseSql).toContain("pg_advisory_xact_lock");
    expect(releaseSql).toContain(
      "'usage:' || p_user_id::text || ':' || v_metric::text"
    );
    expect(releaseSql.match(/GREATEST\(b\.used_count - 1, 0\)/g)).toHaveLength(
      2
    );
    expect(releaseSql).toContain(
      "DELETE FROM public.usage_reservation_leases AS r"
    );
    expect(releaseSql).toContain(
      "RETURN QUERY SELECT false, NULL::integer, NULL::integer"
    );
  });

  it("keeps reservation lifecycle functions securely scoped", () => {
    const sql = usageReleaseMigrationSql();

    expect(sql.match(/SECURITY INVOKER/g)).toHaveLength(3);
    expect(sql.match(/SET search_path = public, pg_temp/g)).toHaveLength(3);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "public"."reserve_usage_limits"'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "public"."release_usage_limits"(uuid, uuid) FROM PUBLIC'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "public"."finalize_usage_reservation"(uuid, uuid) FROM PUBLIC'
    );
    expect(sql).not.toMatch(/https?:\/\//);
    expect(sql).not.toMatch(/\b(?:email|provider_account_id|access_token)\b/i);
    expect(sql).not.toMatch(/plpgsql\.variable_conflict/i);
  });
});
