import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import type { UsagePlanKind } from "./usage-limits";

export type UsageStatusInput = {
  userId: string;
  sessionVersion: number;
};

export type UsageStatusPeriod = {
  used: number;
  limit: number;
  remaining: number;
  resetAt: Date;
};

export type UsageStatusMetric = {
  daily: UsageStatusPeriod;
  monthly: UsageStatusPeriod;
};

export type UsageStatusAvailable = {
  available: true;
  denialReason: null;
  plan: {
    effectivePlanId: string;
    canonicalPlanKey: string;
    kind: UsagePlanKind;
    source: "assignment" | "free_fallback";
    regularVideoLimit: number;
    shortsVideoLimit: number;
  };
  channelAnalysis: UsageStatusMetric;
  aiConsult: UsageStatusMetric;
};

export type UsageStatusDenied = {
  available: false;
  denialReason:
    | "user_not_found"
    | "user_inactive"
    | "session_version_mismatch";
};

export type UsageStatusResult = UsageStatusAvailable | UsageStatusDenied;

type DatabaseExecutor = Pick<Database, "execute">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIAL_REASONS = [
  "user_not_found",
  "user_inactive",
  "session_version_mismatch",
] as const;

export class InvalidUsageStatusInputError extends Error {
  constructor() {
    super("Usage status input is invalid.");
    this.name = "InvalidUsageStatusInputError";
  }
}

export class UsageStatusPersistenceError extends Error {
  constructor() {
    super("Usage status could not be loaded.");
    this.name = "UsageStatusPersistenceError";
  }
}

function normalizeInput(input: UsageStatusInput) {
  if (
    !UUID_PATTERN.test(input.userId) ||
    !Number.isSafeInteger(input.sessionVersion) ||
    input.sessionVersion < 1
  ) {
    throw new InvalidUsageStatusInputError();
  }

  return input;
}

function isDenialReason(
  value: unknown
): value is UsageStatusDenied["denialReason"] {
  return DENIAL_REASONS.some((reason) => reason === value);
}

function parseNonnegativeInteger(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new UsageStatusPersistenceError();
  }
  return value;
}

function parseTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new UsageStatusPersistenceError();
  }
  return date;
}

function parsePlanIdentifier(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    throw new UsageStatusPersistenceError();
  }
  return value;
}

function parsePeriod(
  row: Record<string, unknown>,
  prefix: string
): UsageStatusPeriod {
  const used = parseNonnegativeInteger(row[`${prefix}Used`]);
  const limit = parseNonnegativeInteger(row[`${prefix}Limit`]);
  const remaining = parseNonnegativeInteger(row[`${prefix}Remaining`]);

  if (remaining !== Math.max(limit - used, 0)) {
    throw new UsageStatusPersistenceError();
  }

  return {
    used,
    limit,
    remaining,
    resetAt: parseTimestamp(row[`${prefix}ResetAt`]),
  };
}

function parseUsageStatus(row: unknown): UsageStatusResult {
  if (!row || typeof row !== "object") {
    throw new UsageStatusPersistenceError();
  }

  const candidate = row as Record<string, unknown>;
  if (candidate.available === false) {
    if (!isDenialReason(candidate.denialReason)) {
      throw new UsageStatusPersistenceError();
    }
    return {
      available: false,
      denialReason: candidate.denialReason,
    };
  }

  if (
    candidate.available !== true ||
    candidate.denialReason !== null ||
    candidate.planKind !== "free" ||
    typeof candidate.planFromAssignment !== "boolean"
  ) {
    throw new UsageStatusPersistenceError();
  }

  const effectivePlanId = parsePlanIdentifier(candidate.effectivePlanId);
  const canonicalPlanKey = parsePlanIdentifier(candidate.canonicalPlanKey);
  if (effectivePlanId !== canonicalPlanKey) {
    throw new UsageStatusPersistenceError();
  }

  return {
    available: true,
    denialReason: null,
    plan: {
      effectivePlanId,
      canonicalPlanKey,
      kind: candidate.planKind,
      source: candidate.planFromAssignment
        ? "assignment"
        : "free_fallback",
      regularVideoLimit: parseNonnegativeInteger(
        candidate.regularVideoLimit
      ),
      shortsVideoLimit: parseNonnegativeInteger(candidate.shortsVideoLimit),
    },
    channelAnalysis: {
      daily: parsePeriod(candidate, "analysisDaily"),
      monthly: parsePeriod(candidate, "analysisMonthly"),
    },
    aiConsult: {
      daily: parsePeriod(candidate, "aiDaily"),
      monthly: parsePeriod(candidate, "aiMonthly"),
    },
  };
}

export function buildUsageStatusQuery(input: UsageStatusInput): SQL {
  const normalized = normalizeInput(input);

  return sql`
    SELECT
      "available",
      "denial_reason" AS "denialReason",
      "effective_plan_id" AS "effectivePlanId",
      "canonical_plan_key" AS "canonicalPlanKey",
      "plan_kind" AS "planKind",
      "plan_from_assignment" AS "planFromAssignment",
      "analysis_daily_used" AS "analysisDailyUsed",
      "analysis_daily_limit" AS "analysisDailyLimit",
      "analysis_daily_remaining" AS "analysisDailyRemaining",
      "analysis_daily_reset_at" AS "analysisDailyResetAt",
      "analysis_monthly_used" AS "analysisMonthlyUsed",
      "analysis_monthly_limit" AS "analysisMonthlyLimit",
      "analysis_monthly_remaining" AS "analysisMonthlyRemaining",
      "analysis_monthly_reset_at" AS "analysisMonthlyResetAt",
      "ai_daily_used" AS "aiDailyUsed",
      "ai_daily_limit" AS "aiDailyLimit",
      "ai_daily_remaining" AS "aiDailyRemaining",
      "ai_daily_reset_at" AS "aiDailyResetAt",
      "ai_monthly_used" AS "aiMonthlyUsed",
      "ai_monthly_limit" AS "aiMonthlyLimit",
      "ai_monthly_remaining" AS "aiMonthlyRemaining",
      "ai_monthly_reset_at" AS "aiMonthlyResetAt",
      "regular_video_limit" AS "regularVideoLimit",
      "shorts_video_limit" AS "shortsVideoLimit"
    FROM "public"."get_usage_status_v1"(
      ${normalized.userId}::uuid,
      ${normalized.sessionVersion}::integer
    )
  `;
}

export async function getUsageStatusWithDatabase(
  database: DatabaseExecutor,
  input: UsageStatusInput
): Promise<UsageStatusResult> {
  try {
    const result = await database.execute(buildUsageStatusQuery(input));
    return parseUsageStatus(result.rows[0]);
  } catch (error) {
    if (
      error instanceof InvalidUsageStatusInputError ||
      error instanceof UsageStatusPersistenceError
    ) {
      throw error;
    }
    throw new UsageStatusPersistenceError();
  }
}

export async function getUsageStatus(
  input: UsageStatusInput
): Promise<UsageStatusResult> {
  normalizeInput(input);
  return getUsageStatusWithDatabase(getDatabase(), input);
}
