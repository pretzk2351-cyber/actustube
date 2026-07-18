import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const userStatusEnum = pgEnum("user_status", [
  "active",
  "suspended",
  "deleted",
]);

export const planAssignmentStatusEnum = pgEnum("plan_assignment_status", [
  "active",
  "inactive",
  "expired",
]);

export const planAssignmentSourceEnum = pgEnum("plan_assignment_source", [
  "system",
  "manual",
]);

export const usageMetricEnum = pgEnum("usage_metric", [
  "channel_analysis",
  "ai_consult",
]);

export const usagePeriodKindEnum = pgEnum("usage_period_kind", [
  "day",
  "month",
]);

const auditTimestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 200 }),
    imageUrl: varchar("image_url", { length: 2048 }),
    status: userStatusEnum("status").default("active").notNull(),
    sessionVersion: integer("session_version").default(1).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
    }),
    ...auditTimestamps,
  },
  (table) => [
    index("users_status_idx").on(table.status),
    check("users_session_version_positive", sql`${table.sessionVersion} > 0`),
  ]
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 255,
    }).notNull(),
    grantedScope: text("granted_scope"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...auditTimestamps,
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_account_unique").on(
      table.provider,
      table.providerAccountId
    ),
    index("oauth_accounts_user_id_idx").on(table.userId),
  ]
);

export const plans = pgTable(
  "plans",
  {
    code: varchar("code", { length: 32 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    analysisDailyLimit: integer("analysis_daily_limit").notNull(),
    analysisMonthlyLimit: integer("analysis_monthly_limit").notNull(),
    aiDailyLimit: integer("ai_daily_limit").notNull(),
    aiMonthlyLimit: integer("ai_monthly_limit").notNull(),
    regularVideoLimit: integer("regular_video_limit").notNull(),
    shortsVideoLimit: integer("shorts_video_limit").notNull(),
    historyRetentionDays: integer("history_retention_days").notNull(),
    active: boolean("active").default(true).notNull(),
    ...auditTimestamps,
  },
  (table) => [
    check("plans_code_not_empty", sql`length(${table.code}) > 0`),
    check(
      "plans_limits_nonnegative",
      sql`${table.analysisDailyLimit} >= 0
        AND ${table.analysisMonthlyLimit} >= 0
        AND ${table.aiDailyLimit} >= 0
        AND ${table.aiMonthlyLimit} >= 0
        AND ${table.regularVideoLimit} >= 0
        AND ${table.shortsVideoLimit} >= 0`
    ),
    check(
      "plans_history_retention_positive",
      sql`${table.historyRetentionDays} > 0`
    ),
  ]
);

export const userPlanAssignments = pgTable(
  "user_plan_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 32 })
      .notNull()
      .references(() => plans.code, { onDelete: "restrict" }),
    status: planAssignmentStatusEnum("status").default("active").notNull(),
    source: planAssignmentSourceEnum("source").default("system").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    ...auditTimestamps,
  },
  (table) => [
    uniqueIndex("user_plan_assignments_one_active_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    index("user_plan_assignments_plan_code_idx").on(table.planCode),
    check(
      "user_plan_assignments_valid_period",
      sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`
    ),
  ]
);

export const userUsageBuckets = pgTable(
  "user_usage_buckets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    metric: usageMetricEnum("metric").notNull(),
    periodKind: usagePeriodKindEnum("period_kind").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    usedCount: integer("used_count").default(0).notNull(),
    limitSnapshot: integer("limit_snapshot").notNull(),
    ...auditTimestamps,
  },
  (table) => [
    uniqueIndex("user_usage_buckets_scope_unique").on(
      table.userId,
      table.metric,
      table.periodKind,
      table.periodStart
    ),
    index("user_usage_buckets_period_start_idx").on(table.periodStart),
    check(
      "user_usage_buckets_counts_valid",
      sql`${table.usedCount} >= 0
        AND ${table.limitSnapshot} >= 0
        AND ${table.usedCount} <= ${table.limitSnapshot}`
    ),
  ]
);

export type UserStatus = (typeof userStatusEnum.enumValues)[number];
export type UserRecord = typeof users.$inferSelect;
export type NewUserRecord = typeof users.$inferInsert;
export type OAuthAccountRecord = typeof oauthAccounts.$inferSelect;
export type PlanRecord = typeof plans.$inferSelect;
export type UserPlanAssignmentRecord = typeof userPlanAssignments.$inferSelect;
export type UserUsageBucketRecord = typeof userUsageBuckets.$inferSelect;
