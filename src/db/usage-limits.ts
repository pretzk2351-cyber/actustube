import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { getDatabase, type Database } from "./client";

export const USAGE_METRICS = ["channel_analysis", "ai_consult"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_DENIAL_REASONS = [
  "user_not_found",
  "user_inactive",
  "session_version_mismatch",
  "no_active_plan",
  "daily_limit_reached",
  "monthly_limit_reached",
] as const;
export type UsageDenialReason = (typeof USAGE_DENIAL_REASONS)[number];

export type UsageReservationInput = {
  userId: string;
  sessionVersion: number;
  metric: UsageMetric;
};

type UsageReservationBase = {
  metric: UsageMetric;
  dailyResetAt: Date;
  monthlyResetAt: Date;
};

export type UsageReservationAllowed = UsageReservationBase & {
  allowed: true;
  denialReason: null;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  planCode: string;
};

export type UsageReservationDenied = UsageReservationBase & {
  allowed: false;
  denialReason: UsageDenialReason;
  dailyUsed: number | null;
  dailyLimit: number | null;
  monthlyUsed: number | null;
  monthlyLimit: number | null;
  planCode: string | null;
};

export type UsageReservationResult =
  | UsageReservationAllowed
  | UsageReservationDenied;

type DatabaseExecutor = Pick<Database, "execute">;

export class InvalidUsageReservationInputError extends Error {
  constructor() {
    super("Usage reservation input is invalid.");
    this.name = "InvalidUsageReservationInputError";
  }
}

export class UsageReservationPersistenceError extends Error {
  constructor() {
    super("Usage reservation could not be completed.");
    this.name = "UsageReservationPersistenceError";
  }
}

function isUsageMetric(value: unknown): value is UsageMetric {
  return USAGE_METRICS.some((metric) => metric === value);
}

function isDenialReason(value: unknown): value is UsageDenialReason {
  return USAGE_DENIAL_REASONS.some((reason) => reason === value);
}

function normalizeInput(input: UsageReservationInput) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.userId
    ) ||
    !Number.isSafeInteger(input.sessionVersion) ||
    input.sessionVersion < 1 ||
    !isUsageMetric(input.metric)
  ) {
    throw new InvalidUsageReservationInputError();
  }

  return input;
}

function optionalNonnegativeInteger(value: unknown) {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new UsageReservationPersistenceError();
  }
  return value;
}

function parseTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new UsageReservationPersistenceError();
  }
  return date;
}

function parseResult(row: unknown): UsageReservationResult {
  if (!row || typeof row !== "object") {
    throw new UsageReservationPersistenceError();
  }

  const candidate = row as Record<string, unknown>;
  const allowed = candidate.allowed;
  const denialReason = candidate.denialReason;
  const planCode = candidate.planCode;

  if (
    typeof allowed !== "boolean" ||
    !isUsageMetric(candidate.metric) ||
    (allowed ? denialReason !== null : !isDenialReason(denialReason)) ||
    (planCode !== null &&
      (typeof planCode !== "string" ||
        planCode.length === 0 ||
        planCode.length > 32))
  ) {
    throw new UsageReservationPersistenceError();
  }

  const result = {
    allowed,
    denialReason: allowed ? null : (denialReason as UsageDenialReason),
    metric: candidate.metric,
    dailyUsed: optionalNonnegativeInteger(candidate.dailyUsed),
    dailyLimit: optionalNonnegativeInteger(candidate.dailyLimit),
    dailyResetAt: parseTimestamp(candidate.dailyResetAt),
    monthlyUsed: optionalNonnegativeInteger(candidate.monthlyUsed),
    monthlyLimit: optionalNonnegativeInteger(candidate.monthlyLimit),
    monthlyResetAt: parseTimestamp(candidate.monthlyResetAt),
    planCode: planCode as string | null,
  };

  if (allowed) {
    if (
      result.dailyUsed === null ||
      result.dailyLimit === null ||
      result.monthlyUsed === null ||
      result.monthlyLimit === null ||
      result.planCode === null
    ) {
      throw new UsageReservationPersistenceError();
    }
    return result as UsageReservationAllowed;
  }

  return result as UsageReservationDenied;
}

export function buildUsageReservationQuery(
  input: UsageReservationInput
): SQL {
  const normalized = normalizeInput(input);

  return sql`
    SELECT
      "allowed",
      "denial_reason" AS "denialReason",
      "metric",
      "daily_used" AS "dailyUsed",
      "daily_limit" AS "dailyLimit",
      "daily_reset_at" AS "dailyResetAt",
      "monthly_used" AS "monthlyUsed",
      "monthly_limit" AS "monthlyLimit",
      "monthly_reset_at" AS "monthlyResetAt",
      "plan_code" AS "planCode"
    FROM "public"."reserve_usage_limits"(
      ${normalized.userId}::uuid,
      ${normalized.sessionVersion}::integer,
      ${normalized.metric}::"public"."usage_metric"
    )
  `;
}

export async function reserveUsageWithDatabase(
  database: DatabaseExecutor,
  input: UsageReservationInput
): Promise<UsageReservationResult> {
  const query = buildUsageReservationQuery(input);

  try {
    const result = await database.execute(query);
    const reservation = parseResult(result.rows[0]);
    if (reservation.metric !== input.metric) {
      throw new UsageReservationPersistenceError();
    }
    return reservation;
  } catch (error) {
    if (
      error instanceof InvalidUsageReservationInputError ||
      error instanceof UsageReservationPersistenceError
    ) {
      throw error;
    }
    throw new UsageReservationPersistenceError();
  }
}

export async function reserveUsage(
  input: UsageReservationInput
): Promise<UsageReservationResult> {
  normalizeInput(input);
  return reserveUsageWithDatabase(getDatabase(), input);
}
