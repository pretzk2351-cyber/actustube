import { describe, expect, it, vi } from "vitest";

import {
  currentAnalysisHasAction,
  refreshHistoryForDuplicateAction,
  shouldShowImprovementActionCreateForm,
} from "@/app/lib/weekly-cycle-flow";
import type {
  AnalysisHistoryItem,
  ImprovementActionStatus,
} from "@/app/lib/weekly-cycle-types";

const ANALYSIS_RUN_ID = "3ecce3e0-2dd5-4b57-9a4a-f26b4c7793b3";

function historyItem(status: ImprovementActionStatus | null): AnalysisHistoryItem {
  return {
    id: ANALYSIS_RUN_ID,
    channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
    channelTitle: "Test Channel",
    analyzedAt: "2026-07-20T00:00:00.000Z",
    regularVideoCount: 1,
    shortVideoCount: 1,
    regularAverageViews: 100,
    shortAverageViews: 50,
    hasAIConsult: true,
    aiConsultCreatedAt: "2026-07-20T00:01:00.000Z",
    action: status
      ? {
          id: "267c7d5d-d722-4a64-bcf2-13058333109c",
          analysisRunId: ANALYSIS_RUN_ID,
          title: "Improve the opening",
          description: "Show the result first",
          status,
          resultNote: status === "planned" ? null : "Saved result",
          createdAt: "2026-07-20T00:02:00.000Z",
          updatedAt: "2026-07-20T00:03:00.000Z",
          completedAt:
            status === "completed" ? "2026-07-20T00:03:00.000Z" : null,
        }
      : null,
  };
}

describe("weekly improvement action UI flow", () => {
  it.each(["planned", "completed", "skipped"] as const)(
    "does not show the creation form when the analysis has a %s action",
    (status) => {
      const items = [historyItem(status)];

      expect(currentAnalysisHasAction(items, ANALYSIS_RUN_ID)).toBe(true);
      expect(
        shouldShowImprovementActionCreateForm({
          currentAnalysisRunId: ANALYSIS_RUN_ID,
          items,
          plannedAction: status === "planned" ? items[0].action : null,
          loading: false,
        })
      ).toBe(false);
    }
  );

  it("shows the creation form only after action-free history has loaded", () => {
    const input = {
      currentAnalysisRunId: ANALYSIS_RUN_ID,
      items: [historyItem(null)],
      plannedAction: null,
    };

    expect(
      shouldShowImprovementActionCreateForm({ ...input, loading: true })
    ).toBe(false);
    expect(
      shouldShowImprovementActionCreateForm({ ...input, loading: false })
    ).toBe(true);
  });

  it("refreshes history for the dedicated duplicate conflict without a generic error", async () => {
    const refresh = vi.fn(async () => undefined);

    await expect(
      refreshHistoryForDuplicateAction(
        409,
        { code: "IMPROVEMENT_ACTION_ALREADY_EXISTS" },
        refresh
      )
    ).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not hide unrelated conflicts behind a history refresh", async () => {
    const refresh = vi.fn(async () => undefined);

    await expect(
      refreshHistoryForDuplicateAction(
        409,
        { code: "PLANNED_ACTION_EXISTS" },
        refresh
      )
    ).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
