import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { FREE_PLAN } from "@/db/free-plan";
import {
  oauthAccounts,
  planAssignmentStatusEnum,
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
  return readFileSync(resolve(migrationDirectory, migration), "utf8").replace(
    /\r\n/g,
    "\n"
  );
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

function staleRecoveryMigrationSql() {
  return migrationSql(4);
}

function usageStatusPlanSnapshotMigrationSql() {
  return migrationSql(6);
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

  it("recovers stale leases in bounded, concurrency-safe batches", () => {
    const sql = staleRecoveryMigrationSql();
    const table = getTableConfig(usageReservationLeases);

    expect(table.indexes.map((index) => index.config.name)).toContain(
      "usage_reservation_leases_created_at_idx"
    );
    expect(sql).toContain(
      'CREATE FUNCTION "public"."recover_stale_usage_reservations"'
    );
    expect(sql).toContain("FOR UPDATE OF r SKIP LOCKED");
    expect(sql).toContain("LIMIT p_batch_size");
    expect(sql).toContain("p_batch_size > 500");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain(
      "'usage:' || v_lease.user_id::text || ':' || v_lease.metric::text"
    );
    expect(sql.match(/GREATEST\(b\.used_count - 1, 0\)/g)).toHaveLength(2);
    expect(sql).toContain(
      "DELETE FROM public.usage_reservation_leases AS r"
    );
  });

  it("keeps stale recovery securely scoped and free of secrets", () => {
    const sql = staleRecoveryMigrationSql();

    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = public, pg_temp");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "public"."recover_stale_usage_reservations"'
    );
    expect(sql).not.toMatch(/https?:\/\//);
    expect(sql).not.toMatch(/\b(?:email|provider_account_id|access_token)\b/i);
    expect(sql).not.toMatch(/plpgsql\.variable_conflict/i);
  });

  it("resolves effective usage plans once with explicit fail-closed states", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();
    const resolverStart = sql.indexOf(
      'CREATE FUNCTION "public"."resolve_effective_usage_plan_v1"'
    );
    const reservationStart = sql.indexOf(
      'CREATE FUNCTION "public"."reserve_usage_limits_v2"'
    );
    const resolver = sql.slice(resolverStart, reservationStart);

    expect(resolverStart).toBeGreaterThan(-1);
    expect(resolver).toContain("SELECT COUNT(*)::integer");
    expect(resolver).toContain("IF v_active_assignment_count > 1 THEN");
    expect(resolver).toContain("IF v_active_assignment_count = 1 THEN");
    expect(resolver).toContain("AND upa.status = 'active';");
    expect(resolver).toContain("v_assignment_starts_at > v_now");
    expect(resolver).toContain("v_assignment_ends_at <= v_now");
    expect(resolver).toContain(
      "LEFT JOIN public.plans AS p ON p.code = upa.plan_code"
    );
    expect(resolver).toContain("OR v_effective_plan_id IS NULL");
    expect(resolver).toContain("OR v_plan_active IS DISTINCT FROM true");
    expect(resolver).toContain("WHERE p.code = 'free'");
    expect(resolver).toContain("IF v_free_plan_count <> 1 THEN");
    expect(resolver).toContain(
      "v_effective_plan_id IS DISTINCT FROM 'free'"
    );
    expect(resolver).toContain(
      "v_analysis_daily_limit IS DISTINCT FROM 2"
    );
    expect(resolver).toContain(
      "v_analysis_monthly_limit IS DISTINCT FROM 5"
    );
    expect(resolver).toContain("v_ai_daily_limit IS DISTINCT FROM 1");
    expect(resolver).toContain("v_ai_monthly_limit IS DISTINCT FROM 3");
    expect(resolver).toContain("v_regular_video_limit IS DISTINCT FROM 10");
    expect(resolver).toContain("v_shorts_video_limit IS DISTINCT FROM 10");
    expect(resolver).not.toContain("p.name");
    expect(resolver).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });

  it("treats only active assignments as current candidates", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();
    const resolverStart = sql.indexOf(
      'CREATE FUNCTION "public"."resolve_effective_usage_plan_v1"'
    );
    const reservationStart = sql.indexOf(
      'CREATE FUNCTION "public"."reserve_usage_limits_v2"'
    );
    const resolver = sql.slice(resolverStart, reservationStart);
    const countStart = resolver.indexOf("SELECT COUNT(*)::integer");
    const countEnd = resolver.indexOf("IF v_active_assignment_count > 1 THEN");
    const activeCount = resolver.slice(countStart, countEnd);

    expect(planAssignmentStatusEnum.enumValues).toEqual([
      "active",
      "inactive",
      "expired",
    ]);
    expect(activeCount).toContain("AND upa.status = 'active'");
    expect(activeCount).not.toContain("upa.starts_at <= v_now");
    expect(activeCount).not.toContain("upa.ends_at > v_now");
    expect(resolver).not.toMatch(
      /'cancelled'|'suspended'|'blocked'|'revoked'|'fraud'|'invalid'/
    );
  });

  it("shares UTC boundaries and plan resolution between status and reservation", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();

    expect(sql).toContain(
      'CREATE FUNCTION "public"."usage_period_boundaries_v1"'
    );
    expect(sql).toContain(
      "date_trunc('day', source.effective_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    );
    expect(sql).toContain(
      "date_trunc('month', source.effective_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    );
    expect(
      sql.match(/FROM public\.usage_period_boundaries_v1\(v_now\)/g)
    ).toHaveLength(2);
    expect(
      sql.match(/FROM public\.resolve_effective_usage_plan_v1\(p_user_id, v_now\)/g)
    ).toHaveLength(2);
  });

  it("adds a versioned reservation snapshot without breaking the old contract", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();
    const wrapperStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION "public"."reserve_usage_limits"'
    );
    const statusStart = sql.indexOf(
      'CREATE FUNCTION "public"."get_usage_status_v1"'
    );
    const wrapper = sql.slice(wrapperStart, statusStart);

    expect(sql).toContain(
      'CREATE FUNCTION "public"."reserve_usage_limits_v2"'
    );
    for (const field of [
      '"effective_plan_id" varchar',
      '"canonical_plan_key" varchar',
      '"plan_kind" text',
      '"regular_video_limit" integer',
      '"shorts_video_limit" integer',
      '"plan_from_assignment" boolean',
    ]) {
      expect(sql).toContain(field);
    }
    expect(wrapperStart).toBeGreaterThan(-1);
    expect(wrapper).toContain("FROM public.reserve_usage_limits_v2(");
    expect(wrapper).toContain('"reservation_id" uuid');
    expect(wrapper).not.toContain('"effective_plan_id" varchar');
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    expect(sql).not.toMatch(/\b(?:ALTER|DROP) TABLE\b/i);
    expect(sql).not.toMatch(/\b(?:CREATE|DROP) INDEX\b/i);
  });

  it("keeps usage status strictly read-only and clamps remaining counts", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();
    const statusStart = sql.indexOf(
      'CREATE FUNCTION "public"."get_usage_status_v1"'
    );
    const status = sql.slice(statusStart);

    expect(statusStart).toBeGreaterThan(-1);
    expect(status).toContain("COALESCE(MAX(b.used_count) FILTER");
    expect(status).toContain("Usage counter state is unavailable.");
    expect(status.match(/GREATEST\(/g)).toHaveLength(4);
    expect(status).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(status).not.toContain("pg_advisory_xact_lock");
    expect(status).not.toContain("usage_reservation_leases");
  });

  it("scopes all new SQL functions and revokes their public execution", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();
    const applyStart = sql.indexOf("DO $usage_acl_apply$");
    const definitions = sql.slice(0, applyStart);

    expect(definitions.match(/SECURITY INVOKER/g)).toHaveLength(5);
    expect(definitions.match(/SET search_path = public, pg_temp/g)).toHaveLength(5);
    expect(definitions.match(/^REVOKE ALL ON FUNCTION/gm)).toHaveLength(4);
    expect(sql).toContain("Usage function execution depends on PUBLIC.");
    expect(sql).toContain(
      "REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC"
    );
    expect(sql).toContain("LANGUAGE sql\nSTABLE");
    expect(sql).toContain("LANGUAGE plpgsql\nSTABLE");
    expect(sql.match(/\nVOLATILE\n/g)).toHaveLength(2);
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).not.toMatch(/https?:\/\//);
    expect(sql).not.toMatch(/\b(?:email|provider_account_id|access_token)\b/i);
  });

  it("inherits owner and explicit ACLs from the exact legacy signature", () => {
    const sql = usageStatusPlanSnapshotMigrationSql();

    expect(sql).toContain("DO $usage_acl_preflight$");
    expect(sql).toContain("p.proname = 'reserve_usage_limits'");
    expect(sql).toContain("p.proargtypes = ARRAY[");
    expect(sql).toContain("'public.usage_metric'::pg_catalog.regtype::oid");
    expect(sql).toContain("pg_catalog.aclexplode");
    expect(sql).toContain(
      "current_user::pg_catalog.regrole::oid"
    );
    expect(sql).toContain("ALTER FUNCTION %s OWNER TO %I");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION %s TO %I%s");
    expect(sql).toContain("WITH GRANT OPTION");
    expect(sql).toContain("ALTER FUNCTION %s SECURITY %s");
    expect(sql).toContain(
      "ALTER FUNCTION %s SET search_path = public, pg_temp"
    );
    expect(sql).toContain("A versioned usage function ACL was not preserved.");
    expect(sql).not.toMatch(/\b(?:app_role|runtime_role|migration_role)\b/i);
  });
});
