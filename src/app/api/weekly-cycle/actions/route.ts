import { NextRequest, NextResponse } from "next/server";

import { readJsonObject } from "@/app/lib/api-validation";
import {
  handleApiError,
  getServerUsageIdentity,
  requireApiUserId,
  unauthorizedResponse,
} from "@/app/lib/api-security";
import { parseImprovementActionCreate } from "@/app/lib/weekly-cycle-validation";
import {
  createImprovementAction,
  weeklyCycleIdentityIsValid,
  WeeklyCycleActionAlreadyExistsError,
  WeeklyCycleConflictError,
  WeeklyCycleNotFoundError,
} from "@/db/weekly-cycle";

export async function POST(request: NextRequest) {
  try {
    const userId = await requireApiUserId();
    if (!userId) return unauthorizedResponse();
    const identity = await getServerUsageIdentity(request, userId);
    if (!identity || !(await weeklyCycleIdentityIsValid(identity))) {
      return unauthorizedResponse();
    }

    const input = parseImprovementActionCreate(await readJsonObject(request, 8_192));
    const action = await createImprovementAction({
      userId: identity.userId,
      ...input,
    });
    return NextResponse.json({ action }, { status: 201 });
  } catch (error) {
    if (error instanceof WeeklyCycleNotFoundError) {
      return NextResponse.json(
        { error: "The analysis history item was not found.", code: "ANALYSIS_NOT_FOUND" },
        { status: 404 }
      );
    }
    if (error instanceof WeeklyCycleActionAlreadyExistsError) {
      return NextResponse.json(
        {
          error: "この分析にはすでに改善項目があります。",
          code: "IMPROVEMENT_ACTION_ALREADY_EXISTS",
        },
        { status: 409 }
      );
    }
    if (error instanceof WeeklyCycleConflictError) {
      return NextResponse.json(
        {
          error: "A planned improvement action already exists.",
          code: "PLANNED_ACTION_EXISTS",
        },
        { status: 409 }
      );
    }
    return handleApiError("weekly-cycle-action-create", error);
  }
}
