import { NextRequest, NextResponse } from "next/server";

import { readJsonObject } from "@/app/lib/api-validation";
import {
  handleApiError,
  getServerUsageIdentity,
  requireApiUserId,
  unauthorizedResponse,
} from "@/app/lib/api-security";
import {
  parseImprovementActionUpdate,
  parseUuid,
} from "@/app/lib/weekly-cycle-validation";
import {
  updateImprovementAction,
  weeklyCycleIdentityIsValid,
  WeeklyCycleConflictError,
  WeeklyCycleNotFoundError,
} from "@/db/weekly-cycle";

type RouteContext = { params: Promise<{ actionId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const userId = await requireApiUserId();
    if (!userId) return unauthorizedResponse();
    const identity = await getServerUsageIdentity(request, userId);
    if (!identity || !(await weeklyCycleIdentityIsValid(identity))) {
      return unauthorizedResponse();
    }

    const { actionId: rawActionId } = await context.params;
    const actionId = parseUuid(rawActionId, "actionId");
    const input = parseImprovementActionUpdate(await readJsonObject(request, 8_192));
    const action = await updateImprovementAction({
      userId: identity.userId,
      actionId,
      ...input,
    });
    return NextResponse.json({ action });
  } catch (error) {
    if (error instanceof WeeklyCycleNotFoundError) {
      return NextResponse.json(
        { error: "The improvement action was not found.", code: "ACTION_NOT_FOUND" },
        { status: 404 }
      );
    }
    if (error instanceof WeeklyCycleConflictError) {
      return NextResponse.json(
        {
          error: "This improvement action can no longer be changed.",
          code: "ACTION_NOT_EDITABLE",
        },
        { status: 409 }
      );
    }
    return handleApiError("weekly-cycle-action-update", error);
  }
}
