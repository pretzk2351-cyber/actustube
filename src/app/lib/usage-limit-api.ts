import { NextResponse } from "next/server";

import {
  finalizeUsageReservation,
  releaseUsageReservation,
  reserveUsage,
  type UsageMetric,
  type UsageReservationAllowed,
  type UsageReservationDenied,
} from "@/db/usage-limits";

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
};

export type ApiUsageReservationResult =
  | { allowed: true; reservation: UsageReservationAllowed }
  | { allowed: false; response: NextResponse };

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
  };
}

export function retryAfterSeconds(resetAt: Date, now = Date.now()) {
  return Math.max(1, Math.ceil((resetAt.getTime() - now) / 1_000));
}

function reauthenticationRequiredResponse() {
  return NextResponse.json(
    {
      error: "Authentication is no longer valid. Please sign in again.",
      code: "REAUTHENTICATION_REQUIRED",
    },
    { status: 401 }
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

  const resetAt =
    denial.denialReason === "daily_limit_reached"
      ? denial.dailyResetAt
      : denial.monthlyResetAt;
  const retryAfter = retryAfterSeconds(resetAt);

  return NextResponse.json(
    {
      error: "The usage limit has been reached.",
      code:
        denial.denialReason === "daily_limit_reached"
          ? "DAILY_USAGE_LIMIT_REACHED"
          : "MONTHLY_USAGE_LIMIT_REACHED",
      metric: denial.metric,
      dailyUsed: denial.dailyUsed,
      dailyLimit: denial.dailyLimit,
      dailyResetAt: denial.dailyResetAt.toISOString(),
      monthlyUsed: denial.monthlyUsed,
      monthlyLimit: denial.monthlyLimit,
      monthlyResetAt: denial.monthlyResetAt.toISOString(),
      planCode: denial.planCode,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    }
  );
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

  try {
    await recoverExpiredUsageReservations(OPPORTUNISTIC_RECOVERY_BATCH_SIZE);
  } catch (error) {
    logSafeLifecycleError("usage-reservation-opportunistic-recovery", error);
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
