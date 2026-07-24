import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  getServerUsageIdentity,
  handleApiError,
  requireApiUserId,
  unauthorizedResponse,
} from "@/app/lib/api-security";
import { reauthenticationRequiredResponse } from "@/app/lib/usage-limit-api";
import { getUsageStatus } from "@/db/usage-status";

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
};

function withPrivateNoStore(response: NextResponse) {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const GET = auth(async function GET(request) {
  try {
    const userId = await requireApiUserId(request.auth);
    if (!userId) return withPrivateNoStore(unauthorizedResponse());

    const identity = await getServerUsageIdentity(request, userId);
    if (!identity) {
      return withPrivateNoStore(reauthenticationRequiredResponse());
    }

    const result = await getUsageStatus(identity);
    if (!result.available) {
      if (
        result.denialReason === "user_not_found" ||
        result.denialReason === "session_version_mismatch"
      ) {
        return withPrivateNoStore(reauthenticationRequiredResponse());
      }

      return NextResponse.json(
        {
          error: "This account is not available.",
          code: "ACCOUNT_UNAVAILABLE",
        },
        { status: 403, headers: PRIVATE_NO_STORE_HEADERS }
      );
    }

    const serializePeriod = (period: {
      used: number;
      limit: number;
      remaining: number;
      resetAt: Date;
    }) => ({
      used: period.used,
      limit: period.limit,
      remaining: period.remaining,
      resetAt: period.resetAt.toISOString(),
    });

    return NextResponse.json(
      {
        plan: {
          effectivePlanId: result.plan.effectivePlanId,
          code: result.plan.canonicalPlanKey,
          kind: result.plan.kind,
          source: result.plan.source,
          regularVideoLimit: result.plan.regularVideoLimit,
          shortsVideoLimit: result.plan.shortsVideoLimit,
        },
        usage: {
          channelAnalysis: {
            daily: serializePeriod(result.channelAnalysis.daily),
            monthly: serializePeriod(result.channelAnalysis.monthly),
          },
          aiConsult: {
            daily: serializePeriod(result.aiConsult.daily),
            monthly: serializePeriod(result.aiConsult.monthly),
          },
        },
      },
      { headers: PRIVATE_NO_STORE_HEADERS }
    );
  } catch (error) {
    return withPrivateNoStore(handleApiError("usage-status", error));
  }
});
