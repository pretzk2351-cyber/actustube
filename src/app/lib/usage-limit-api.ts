import { NextResponse } from "next/server";

import {
  assertUsageSchemaCompatibility,
  finalizeUsageReservation,
  releaseUsageReservation,
  reserveUsage,
  type UsageMetric,
  type UsageReservationAllowed,
  type UsageReservationDenied,
} from "@/db/usage-limits";
import {
  getUsageStatus,
  type UsageStatusAvailable,
} from "@/db/usage-status";

import { getServerUsageIdentity } from "./api-security";
import {
  OPPORTUNISTIC_RECOVERY_BATCH_SIZE,
  recoverExpiredUsageReservations,
} from "./stale-reservation-recovery";

export type PublicUsage = {
  metric: UsageMetric;
  planCode: string;
  dailyUsed: number;
  dailyLimit: number;
  dailyResetAt: string;
  monthlyUsed: number;
  monthlyLimit: number;
  monthlyResetAt: string;
  regularVideoLimit: number;
  shortsVideoLimit: number;
};

export type ApiUsageReservationResult =
  | { allowed: true; reservation: UsageReservationAllowed }
  | { allowed: false; response: NextResponse };

export type ServerUsageIdentity = {
  userId: string;
  sessionVersion: number;
};

const PREPARED_API_USAGE = Symbol("prepared-api-usage");
const COMPATIBLE_API_USAGE = Symbol("compatible-api-usage");

export type CompatibleApiUsage = {
  readonly marker: typeof COMPATIBLE_API_USAGE;
};

export type PreparedApiUsage = {
  readonly marker: typeof PREPARED_API_USAGE;
};

export function publicUsage(
  reservation: UsageReservationAllowed
): PublicUsage {
  return {
    metric: reservation.metric,
    planCode: reservation.planCode,
    dailyUsed: reservation.dailyUsed,
    dailyLimit: reservation.dailyLimit,
    dailyResetAt: reservation.dailyResetAt.toISOString(),
    monthlyUsed: reservation.monthlyUsed,
    monthlyLimit: reservation.monthlyLimit,
    monthlyResetAt: reservation.monthlyResetAt.toISOString(),
    regularVideoLimit: reservation.regularVideoLimit,
    shortsVideoLimit: reservation.shortsVideoLimit,
  };
}

export function retryAfterSeconds(resetAt: Date, now = Date.now()) {
  return Math.max(1, Math.ceil((resetAt.getTime() - now) / 1_000));
}

export function reauthenticationRequiredResponse() {
  return NextResponse.json(
    {
      error: "Authentication is no longer valid. Please sign in again.",
      code: "REAUTHENTICATION_REQUIRED",
    },
    { status: 401 }
  );
}

function usageLimitResponse(
  denialReason: "daily_limit_reached" | "monthly_limit_reached",
  usage: {
    metric: UsageMetric;
    dailyUsed: number;
    dailyLimit: number;
    dailyResetAt: Date;
    monthlyUsed: number;
    monthlyLimit: number;
    monthlyResetAt: Date;
    planCode: string;
  }
) {
  const resetAt =
    denialReason === "daily_limit_reached"
      ? usage.dailyResetAt
      : usage.monthlyResetAt;
  const retryAfter = retryAfterSeconds(resetAt);

  return NextResponse.json(
    {
      error: "The usage limit has been reached.",
      code:
        denialReason === "daily_limit_reached"
          ? "DAILY_USAGE_LIMIT_REACHED"
          : "MONTHLY_USAGE_LIMIT_REACHED",
      metric: usage.metric,
      dailyUsed: usage.dailyUsed,
      dailyLimit: usage.dailyLimit,
      dailyResetAt: usage.dailyResetAt.toISOString(),
      monthlyUsed: usage.monthlyUsed,
      monthlyLimit: usage.monthlyLimit,
      monthlyResetAt: usage.monthlyResetAt.toISOString(),
      planCode: usage.planCode,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    }
  );
}

function denialResponse(denial: UsageReservationDenied) {
  if (
    denial.denialReason === "user_not_found" ||
    denial.denialReason === "session_version_mismatch"
  ) {
    return reauthenticationRequiredResponse();
  }

  if (denial.denialReason === "user_inactive") {
    return NextResponse.json(
      {
        error: "This account is not available.",
        code: "ACCOUNT_UNAVAILABLE",
      },
      { status: 403 }
    );
  }

  if (denial.denialReason === "no_active_plan") {
    return NextResponse.json(
      {
        error: "No available plan is assigned to this account.",
        code: "NO_ACTIVE_PLAN",
      },
      { status: 403 }
    );
  }

  if (
    denial.dailyUsed === null ||
    denial.dailyLimit === null ||
    denial.monthlyUsed === null ||
    denial.monthlyLimit === null ||
    denial.planCode === null
  ) {
    throw new Error("UsageLimitDenialInvalid");
  }

  return usageLimitResponse(denial.denialReason, {
    metric: denial.metric,
    dailyUsed: denial.dailyUsed,
    dailyLimit: denial.dailyLimit,
    dailyResetAt: denial.dailyResetAt,
    monthlyUsed: denial.monthlyUsed,
    monthlyLimit: denial.monthlyLimit,
    monthlyResetAt: denial.monthlyResetAt,
    planCode: denial.planCode,
  });
}

export async function assertApiUsageCompatibility(): Promise<CompatibleApiUsage> {
  await assertUsageSchemaCompatibility();

  return { marker: COMPATIBLE_API_USAGE };
}

export async function prepareApiUsage(
  compatible?: CompatibleApiUsage
): Promise<PreparedApiUsage> {
  if (compatible?.marker !== COMPATIBLE_API_USAGE) {
    await assertApiUsageCompatibility();
  }

  try {
    await recoverExpiredUsageReservations(OPPORTUNISTIC_RECOVERY_BATCH_SIZE);
  } catch (error) {
    logSafeLifecycleError("usage-reservation-opportunistic-recovery", error);
  }

  return { marker: PREPARED_API_USAGE };
}

export async function preflightApiUsageForIdentity(
  identity: ServerUsageIdentity,
  metric: UsageMetric
): Promise<ApiUsageReservationResult | { allowed: true }> {
  const status = await getUsageStatus(identity);

  if (!status.available) {
    if (
      status.denialReason === "user_not_found" ||
      status.denialReason === "session_version_mismatch"
    ) {
      return { allowed: false, response: reauthenticationRequiredResponse() };
    }

    return {
      allowed: false,
      response: NextResponse.json(
        {
          error: "This account is not available.",
          code: "ACCOUNT_UNAVAILABLE",
        },
        { status: 403 }
      ),
    };
  }

  const usage = usageForMetric(status, metric);
  if (usage.daily.remaining === 0 || usage.monthly.remaining === 0) {
    return {
      allowed: false,
      response: usageLimitResponse(
        usage.daily.remaining === 0
          ? "daily_limit_reached"
          : "monthly_limit_reached",
        {
          metric,
          dailyUsed: usage.daily.used,
          dailyLimit: usage.daily.limit,
          dailyResetAt: usage.daily.resetAt,
          monthlyUsed: usage.monthly.used,
          monthlyLimit: usage.monthly.limit,
          monthlyResetAt: usage.monthly.resetAt,
          planCode: status.plan.canonicalPlanKey,
        }
      ),
    };
  }

  return { allowed: true };
}

function usageForMetric(status: UsageStatusAvailable, metric: UsageMetric) {
  return metric === "channel_analysis"
    ? status.channelAnalysis
    : status.aiConsult;
}

export async function reserveApiUsage(
  request: Request,
  sessionUserId: string,
  metric: UsageMetric
): Promise<ApiUsageReservationResult> {
  const identity = await getServerUsageIdentity(request, sessionUserId);
  if (!identity) {
    return { allowed: false, response: reauthenticationRequiredResponse() };
  }

  return reserveApiUsageForIdentity(identity, metric);
}

export async function reserveApiUsageForIdentity(
  identity: ServerUsageIdentity,
  metric: UsageMetric,
  prepared?: PreparedApiUsage
): Promise<ApiUsageReservationResult> {
  if (prepared?.marker !== PREPARED_API_USAGE) {
    await prepareApiUsage();
  }

  const reservation = await reserveUsage({
    userId: identity.userId,
    sessionVersion: identity.sessionVersion,
    metric,
  });

  if (!reservation.allowed) {
    return { allowed: false, response: denialResponse(reservation) };
  }

  return { allowed: true, reservation };
}

function logSafeLifecycleError(context: string, error: unknown) {
  console.error(`${context} failed`, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

export async function runWithUsageReservation<T>(
  reservation: UsageReservationAllowed,
  userId: string,
  operation: () => Promise<T>,
  options?: { finalize: (result: T) => Promise<boolean> }
) {
  try {
    const result = await operation();

    if (options) {
      const finalized = await options.finalize(result);
      if (!finalized) {
        throw new Error("UsageReservationFinalizationFailed");
      }
      return result;
    }

    try {
      const finalized = await finalizeUsageReservation({
        reservationId: reservation.reservationId,
        userId,
      });
      if (!finalized) {
        logSafeLifecycleError(
          "usage-reservation-finalize",
          new Error("ReservationNotFound")
        );
      }
    } catch (error) {
      logSafeLifecycleError("usage-reservation-finalize", error);
    }

    return result;
  } catch (error) {
    try {
      await releaseUsageReservation({
        reservationId: reservation.reservationId,
        userId,
      });
    } catch (releaseError) {
      logSafeLifecycleError("usage-reservation-release", releaseError);
    }

    throw error;
  }
}
