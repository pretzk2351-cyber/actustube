import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { getDatabase, type Database } from "./client";

export const USAGE_METRICS = ["channel_analysis", "ai_consult"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export const USAGE_PLAN_KINDS = ["free"] as const;
export type UsagePlanKind = (typeof USAGE_PLAN_KINDS)[number];

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
  reservationId: string;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  planCode: string;
  effectivePlanId: string;
  canonicalPlanKey: string;
  planKind: UsagePlanKind;
  regularVideoLimit: number;
  shortsVideoLimit: number;
  planFromAssignment: boolean;
};

export type UsageReservationDenied = UsageReservationBase & {
  allowed: false;
  denialReason: UsageDenialReason;
  reservationId: null;
  dailyUsed: number | null;
  dailyLimit: number | null;
  monthlyUsed: number | null;
  monthlyLimit: number | null;
  planCode: string | null;
  effectivePlanId: string | null;
  canonicalPlanKey: string | null;
  planKind: UsagePlanKind | null;
  regularVideoLimit: number | null;
  shortsVideoLimit: number | null;
  planFromAssignment: boolean | null;
};

export type UsageReservationResult =
  | UsageReservationAllowed
  | UsageReservationDenied;

type DatabaseExecutor = Pick<Database, "execute">;

export type UsageReservationReference = {
  reservationId: string;
  userId: string;
};

export type UsageReleaseResult = {
  released: boolean;
  dailyUsed: number | null;
  monthlyUsed: number | null;
};

export type StaleReservationRecoveryInput = {
  staleBefore: Date;
  batchSize?: number;
};

export type StaleReservationRecoveryResult = {
  recovered: number;
};

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

export class UsageReservationLifecyclePersistenceError extends Error {
  constructor() {
    super("Usage reservation state could not be updated.");
    this.name = "UsageReservationLifecyclePersistenceError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUsageMetric(value: unknown): value is UsageMetric {
  return USAGE_METRICS.some((metric) => metric === value);
}

function isDenialReason(value: unknown): value is UsageDenialReason {
  return USAGE_DENIAL_REASONS.some((reason) => reason === value);
}

export function buildUsageSchemaCompatibilityQuery(): SQL {
  return sql`
    SELECT
      pg_catalog.to_regprocedure(
        'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)'
      ) IS NOT NULL
      AND pg_catalog.to_regprocedure(
        'public.get_usage_status_v1(uuid,integer,timestamp with time zone)'
      ) IS NOT NULL AS "available"
  `;
}

export async function assertUsageSchemaCompatibilityWithDatabase(
  database: DatabaseExecutor
) {
  try {
    const result = await database.execute(buildUsageSchemaCompatibilityQuery());
    if (result.rows.length !== 1 || result.rows[0]?.available !== true) {
      throw new UsageReservationPersistenceError();
    }
  } catch (error) {
    if (error instanceof UsageReservationPersistenceError) throw error;
    throw new UsageReservationPersistenceError();
  }
}

export async function assertUsageSchemaCompatibility() {
  return assertUsageSchemaCompatibilityWithDatabase(getDatabase());
}

function isUsagePlanKind(value: unknown): value is UsagePlanKind {
  return USAGE_PLAN_KINDS.some((planKind) => planKind === value);
}

function normalizeInput(input: UsageReservationInput) {
  if (
    !UUID_PATTERN.test(input.userId) ||
    !Number.isSafeInteger(input.sessionVersion) ||
    input.sessionVersion < 1 ||
    !isUsageMetric(input.metric)
  ) {
    throw new InvalidUsageReservationInputError();
  }

  return input;
}

function normalizeReservationReference(input: UsageReservationReference) {
  if (!UUID_PATTERN.test(input.reservationId) || !UUID_PATTERN.test(input.userId)) {
    throw new InvalidUsageReservationInputError();
  }

  return input;
}

function normalizeRecoveryInput(input: StaleReservationRecoveryInput) {
  const batchSize = input.batchSize ?? 100;
  if (
    !(input.staleBefore instanceof Date) ||
    Number.isNaN(input.staleBefore.getTime()) ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 500
  ) {
    throw new InvalidUsageReservationInputError();
  }

  return { staleBefore: input.staleBefore, batchSize };
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
  const reservationId = candidate.reservationId;
  const effectivePlanId = candidate.effectivePlanId;
  const canonicalPlanKey = candidate.canonicalPlanKey;
  const planKind = candidate.planKind;
  const planFromAssignment = candidate.planFromAssignment;

  if (
    typeof allowed !== "boolean" ||
    !isUsageMetric(candidate.metric) ||
    (allowed ? denialReason !== null : !isDenialReason(denialReason)) ||
    (planCode !== null &&
      (typeof planCode !== "string" ||
        planCode.length === 0 ||
        planCode.length > 32)) ||
    (reservationId !== null &&
      (typeof reservationId !== "string" || !UUID_PATTERN.test(reservationId))) ||
    (effectivePlanId !== null &&
      (typeof effectivePlanId !== "string" ||
        effectivePlanId.length === 0 ||
        effectivePlanId.length > 32)) ||
    (canonicalPlanKey !== null &&
      (typeof canonicalPlanKey !== "string" ||
        canonicalPlanKey.length === 0 ||
        canonicalPlanKey.length > 32)) ||
    (planKind !== null && !isUsagePlanKind(planKind)) ||
    (planFromAssignment !== null && typeof planFromAssignment !== "boolean")
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
    reservationId: reservationId as string | null,
    effectivePlanId: effectivePlanId as string | null,
    canonicalPlanKey: canonicalPlanKey as string | null,
    planKind: planKind as UsagePlanKind | null,
    regularVideoLimit: optionalNonnegativeInteger(
      candidate.regularVideoLimit
    ),
    shortsVideoLimit: optionalNonnegativeInteger(candidate.shortsVideoLimit),
    planFromAssignment: planFromAssignment as boolean | null,
  };

  if (allowed) {
    if (
      result.dailyUsed === null ||
      result.dailyLimit === null ||
      result.monthlyUsed === null ||
      result.monthlyLimit === null ||
      result.planCode === null ||
      result.reservationId === null ||
      result.effectivePlanId === null ||
      result.canonicalPlanKey === null ||
      result.planKind === null ||
      result.regularVideoLimit === null ||
      result.shortsVideoLimit === null ||
      result.planFromAssignment === null ||
      result.planCode !== result.canonicalPlanKey
    ) {
      throw new UsageReservationPersistenceError();
    }
    return result as UsageReservationAllowed;
  }

  if (result.reservationId !== null) {
    throw new UsageReservationPersistenceError();
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
      "plan_code" AS "planCode",
      "reservation_id" AS "reservationId",
      "effective_plan_id" AS "effectivePlanId",
      "canonical_plan_key" AS "canonicalPlanKey",
      "plan_kind" AS "planKind",
      "regular_video_limit" AS "regularVideoLimit",
      "shorts_video_limit" AS "shortsVideoLimit",
      "plan_from_assignment" AS "planFromAssignment"
    FROM "public"."reserve_usage_limits_v2"(
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

export function buildReleaseUsageQuery(
  input: UsageReservationReference
): SQL {
  const normalized = normalizeReservationReference(input);

  return sql`
    SELECT
      "released",
      "daily_used" AS "dailyUsed",
      "monthly_used" AS "monthlyUsed"
    FROM "public"."release_usage_limits"(
      ${normalized.reservationId}::uuid,
      ${normalized.userId}::uuid
    )
  `;
}

export async function releaseUsageReservationWithDatabase(
  database: DatabaseExecutor,
  input: UsageReservationReference
): Promise<UsageReleaseResult> {
  const query = buildReleaseUsageQuery(input);

  try {
    const row = (await database.execute(query)).rows[0];
    if (!row || typeof row !== "object") {
      throw new UsageReservationLifecyclePersistenceError();
    }

    const candidate = row as Record<string, unknown>;
    if (typeof candidate.released !== "boolean") {
      throw new UsageReservationLifecyclePersistenceError();
    }

    const dailyUsed = optionalNonnegativeInteger(candidate.dailyUsed);
    const monthlyUsed = optionalNonnegativeInteger(candidate.monthlyUsed);
    if (
      candidate.released
        ? dailyUsed === null || monthlyUsed === null
        : dailyUsed !== null || monthlyUsed !== null
    ) {
      throw new UsageReservationLifecyclePersistenceError();
    }

    return { released: candidate.released, dailyUsed, monthlyUsed };
  } catch (error) {
    if (
      error instanceof InvalidUsageReservationInputError ||
      error instanceof UsageReservationLifecyclePersistenceError
    ) {
      throw error;
    }
    throw new UsageReservationLifecyclePersistenceError();
  }
}

export async function releaseUsageReservation(
  input: UsageReservationReference
): Promise<UsageReleaseResult> {
  normalizeReservationReference(input);
  return releaseUsageReservationWithDatabase(getDatabase(), input);
}

export function buildFinalizeUsageReservationQuery(
  input: UsageReservationReference
): SQL {
  const normalized = normalizeReservationReference(input);

  return sql`
    SELECT "public"."finalize_usage_reservation"(
      ${normalized.reservationId}::uuid,
      ${normalized.userId}::uuid
    ) AS "finalized"
  `;
}

export async function finalizeUsageReservationWithDatabase(
  database: DatabaseExecutor,
  input: UsageReservationReference
): Promise<boolean> {
  const query = buildFinalizeUsageReservationQuery(input);

  try {
    const row = (await database.execute(query)).rows[0];
    if (
      !row ||
      typeof row !== "object" ||
      typeof (row as Record<string, unknown>).finalized !== "boolean"
    ) {
      throw new UsageReservationLifecyclePersistenceError();
    }
    return (row as Record<string, boolean>).finalized;
  } catch (error) {
    if (
      error instanceof InvalidUsageReservationInputError ||
      error instanceof UsageReservationLifecyclePersistenceError
    ) {
      throw error;
    }
    throw new UsageReservationLifecyclePersistenceError();
  }
}

export async function finalizeUsageReservation(
  input: UsageReservationReference
): Promise<boolean> {
  normalizeReservationReference(input);
  return finalizeUsageReservationWithDatabase(getDatabase(), input);
}

export function buildRecoverStaleUsageReservationsQuery(
  input: StaleReservationRecoveryInput
): SQL {
  const normalized = normalizeRecoveryInput(input);

  return sql`
    SELECT "public"."recover_stale_usage_reservations"(
      ${normalized.staleBefore.toISOString()}::timestamp with time zone,
      ${normalized.batchSize}::integer
    ) AS "recovered"
  `;
}

export async function recoverStaleUsageReservationsWithDatabase(
  database: DatabaseExecutor,
  input: StaleReservationRecoveryInput
): Promise<StaleReservationRecoveryResult> {
  const query = buildRecoverStaleUsageReservationsQuery(input);

  try {
    const row = (await database.execute(query)).rows[0];
    const recovered =
      row && typeof row === "object"
        ? (row as Record<string, unknown>).recovered
        : null;
    if (
      typeof recovered !== "number" ||
      !Number.isSafeInteger(recovered) ||
      recovered < 0 ||
      recovered > (input.batchSize ?? 100)
    ) {
      throw new UsageReservationLifecyclePersistenceError();
    }
    return { recovered };
  } catch (error) {
    if (
      error instanceof InvalidUsageReservationInputError ||
      error instanceof UsageReservationLifecyclePersistenceError
    ) {
      throw error;
    }
    throw new UsageReservationLifecyclePersistenceError();
  }
}

export async function recoverStaleUsageReservations(
  input: StaleReservationRecoveryInput
): Promise<StaleReservationRecoveryResult> {
  normalizeRecoveryInput(input);
  return recoverStaleUsageReservationsWithDatabase(getDatabase(), input);
}
