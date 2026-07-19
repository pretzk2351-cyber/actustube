import { NextRequest, NextResponse } from "next/server";

import { RequestValidationError } from "@/app/lib/api-validation";
import {
  handleApiError,
  getServerUsageIdentity,
  requireApiUserId,
  unauthorizedResponse,
} from "@/app/lib/api-security";
import { parseHistoryLimit } from "@/app/lib/weekly-cycle-validation";
import {
  decodeHistoryCursor,
  listWeeklyCycles,
  weeklyCycleIdentityIsValid,
  WeeklyCyclePersistenceError,
} from "@/db/weekly-cycle";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const userId = await requireApiUserId();
    if (!userId) return unauthorizedResponse();
    const identity = await getServerUsageIdentity(request, userId);
    if (!identity || !(await weeklyCycleIdentityIsValid(identity))) {
      return unauthorizedResponse();
    }

    const limit = parseHistoryLimit(request.nextUrl.searchParams.get("limit"));
    let cursor;
    try {
      cursor = decodeHistoryCursor(request.nextUrl.searchParams.get("cursor"));
    } catch (error) {
      if (error instanceof WeeklyCyclePersistenceError) {
        throw new RequestValidationError("cursor is invalid.");
      }
      throw error;
    }

    const history = await listWeeklyCycles({
      userId: identity.userId,
      limit,
      cursor,
    });
    return NextResponse.json(history, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError("weekly-cycle-history", error);
  }
}
