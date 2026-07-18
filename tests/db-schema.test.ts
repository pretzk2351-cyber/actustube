import { createHash } from "node:crypto";
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
    const sql = `${initialMigrationSql()}\n${conflictFixMigrationSql()}`;

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

  it("keeps the applied initial migration unchanged", () => {
    const normalizedSql = initialMigrationSql().replaceAll("\r\n", "\n");
    const hash = createHash("sha256").update(normalizedSql).digest("hex");

    expect(hash).toBe(
      "9bc21d6a4f264ae7e77d790a19cc3165b18c694f02c2c6d7ccdb0d066f36b368"
    );
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
});
