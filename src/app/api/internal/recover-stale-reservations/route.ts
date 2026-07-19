import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  recoverExpiredUsageReservations,
  SCHEDULED_RECOVERY_BATCH_SIZE,
} from "@/app/lib/stale-reservation-recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

function noStoreJson(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function matchesCronSecret(authorization: string | null, secret: string) {
  const actual = createHash("sha256")
    .update(authorization ?? "")
    .digest();
  const expected = createHash("sha256")
    .update(`Bearer ${secret}`)
    .digest();
  return timingSafeEqual(actual, expected);
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.length < 16) {
    return noStoreJson(
      {
        success: false,
        code: "CRON_CONFIGURATION_UNAVAILABLE",
      },
      503
    );
  }

  if (!matchesCronSecret(request.headers.get("authorization"), cronSecret)) {
    return noStoreJson({ success: false, code: "UNAUTHORIZED" }, 401);
  }

  try {
    const result = await recoverExpiredUsageReservations(
      SCHEDULED_RECOVERY_BATCH_SIZE
    );
    return noStoreJson({ success: true, recovered: result.recovered }, 200);
  } catch (error) {
    console.error("stale-reservation-recovery failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson(
      { success: false, code: "STALE_RESERVATION_RECOVERY_FAILED" },
      500
    );
  }
}
