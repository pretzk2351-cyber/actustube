import { describe, expect, it, vi } from "vitest";

import {
  canRequestAIConsult,
  evaluateChannelAnalysisResponse,
  getSafeClientApiErrorMessage,
  isAIConsultButtonDisabled,
} from "@/app/lib/youtube-form-flow";

function validSummary(channelTitle = "Test Channel") {
  const section = {
    count: 0,
    averageViews: 0,
    postingFrequency: "判定不可",
    topVideo: null,
    lowVideo: null,
    videos: [],
  };

  return {
    channelTitle,
    regular: section,
    shorts: { ...section },
  };
}

describe("YouTube form flow", () => {
  it.each([400, 401, 403, 429, 500])(
    "stops after a channel analysis %s response without permitting AI consult",
    (status) => {
      const decision = evaluateChannelAnalysisResponse(status, {
        error: "raw internal error",
        code: status === 429 ? "DAILY_USAGE_LIMIT_REACHED" : undefined,
        dailyResetAt: "2026-07-20T00:00:00.000Z",
      });
      const requestAIConsult = vi.fn();

      if (decision.accepted && canRequestAIConsult(validSummary())) {
        requestAIConsult();
      }

      expect(decision.accepted).toBe(false);
      expect(requestAIConsult).not.toHaveBeenCalled();
    }
  );

  it("does not reuse an old summary after the next analysis fails", () => {
    const oldSummary = validSummary("Previous Channel");
    expect(canRequestAIConsult(oldSummary)).toBe(true);

    const nextAnalysis = evaluateChannelAnalysisResponse(429, {
      code: "DAILY_USAGE_LIMIT_REACHED",
    });
    const nextSummary = nextAnalysis.accepted ? oldSummary : null;

    expect(nextSummary).toBeNull();
    expect(canRequestAIConsult(nextSummary)).toBe(false);
  });

  it.each(["", " ", "x".repeat(201), "invalid\u0000title"])(
    "disables AI consult for an invalid channel title",
    (channelTitle) => {
      expect(canRequestAIConsult(validSummary(channelTitle))).toBe(false);
    }
  );

  it("permits AI consult after a valid channel analysis", () => {
    const decision = evaluateChannelAnalysisResponse(200, {
      analysisRunId: "3ecce3e0-2dd5-4b57-9a4a-f26b4c7793b3",
      channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      channelTitle: "Test Channel",
      regularVideos: [],
      shortVideos: [],
    });
    const requestAIConsult = vi.fn();

    if (decision.accepted) {
      const summary = validSummary(decision.analysis.channelTitle);
      if (canRequestAIConsult(summary)) requestAIConsult();
    }

    expect(decision.accepted).toBe(true);
    expect(requestAIConsult).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      state: {
        hasValidAnalysis: false,
        analysisLoading: false,
        consultLoading: false,
      },
      disabled: true,
    },
    {
      state: {
        hasValidAnalysis: true,
        analysisLoading: false,
        consultLoading: false,
      },
      disabled: false,
    },
    {
      state: {
        hasValidAnalysis: true,
        analysisLoading: true,
        consultLoading: false,
      },
      disabled: true,
    },
    {
      state: {
        hasValidAnalysis: true,
        analysisLoading: false,
        consultLoading: true,
      },
      disabled: true,
    },
  ])("derives the consult button disabled state", ({ state, disabled }) => {
    expect(isAIConsultButtonDisabled(state)).toBe(disabled);
  });

  it("translates a daily 429 and shows the reset time in Japan", () => {
    const message = getSafeClientApiErrorMessage(
      429,
      {
        code: "DAILY_USAGE_LIMIT_REACHED",
        dailyResetAt: "2026-07-20T00:00:00.000Z",
      },
      "channel_analysis"
    );

    expect(message).toBe(
      "本日の利用上限に達しました。リセット後にもう一度お試しください。 次回は2026年07月20日 09:00（日本時間）から利用できます。"
    );
  });

  it("translates a monthly 429 and shows the reset time in Japan", () => {
    const message = getSafeClientApiErrorMessage(
      429,
      {
        code: "MONTHLY_USAGE_LIMIT_REACHED",
        monthlyResetAt: "2026-08-01T00:00:00.000Z",
      },
      "ai_consult"
    );

    expect(message).toBe(
      "今月の利用上限に達しました。 次回は2026年08月01日 09:00（日本時間）から利用できます。"
    );
  });

  it("never exposes an internal API validation message", () => {
    const internalMessage = "aiSummary.channelTitle has an invalid length.";
    const message = getSafeClientApiErrorMessage(
      400,
      { error: internalMessage },
      "ai_consult"
    );

    expect(message).toBe(
      "AI提案に必要な分析結果が無効です。チャンネルを再分析してください。"
    );
    expect(message).not.toContain(internalMessage);
    expect(message).not.toContain("aiSummary.channelTitle");
  });
});
