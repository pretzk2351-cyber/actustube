import { describe, expect, it, vi } from "vitest";

import {
  canRequestAIConsult,
  evaluateChannelAnalysisResponse,
  getSafeClientApiErrorFeedback,
  getSafeClientApiErrorMessage,
  getSafeClientNetworkErrorFeedback,
  hasUsageRemaining,
  isAIConsultButtonDisabled,
  parseOwnedChannelsResponse,
  parseUsageStatusResponse,
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
  it("accepts only a complete server usage snapshot", () => {
    const status = parseUsageStatusResponse({
      plan: {
        effectivePlanId: "free",
        code: "free",
        kind: "free",
        source: "free_fallback",
        regularVideoLimit: 10,
        shortsVideoLimit: 10,
      },
      usage: {
        channelAnalysis: {
          daily: {
            used: 0,
            limit: 2,
            remaining: 2,
            resetAt: "2026-07-25T00:00:00.000Z",
          },
          monthly: {
            used: 1,
            limit: 5,
            remaining: 4,
            resetAt: "2026-08-01T00:00:00.000Z",
          },
        },
        aiConsult: {
          daily: {
            used: 1,
            limit: 1,
            remaining: 0,
            resetAt: "2026-07-25T00:00:00.000Z",
          },
          monthly: {
            used: 1,
            limit: 3,
            remaining: 2,
            resetAt: "2026-08-01T00:00:00.000Z",
          },
        },
      },
    });

    expect(status?.plan).toMatchObject({
      code: "free",
      regularVideoLimit: 10,
      shortsVideoLimit: 10,
    });
    expect(status && hasUsageRemaining(status.usage.channelAnalysis)).toBe(true);
    expect(status && hasUsageRemaining(status.usage.aiConsult)).toBe(false);
  });

  it.each([
    { plan: { effectivePlanId: "free", code: "paid" } },
    { plan: { effectivePlanId: "free", code: "free", kind: "paid" } },
    { remaining: 3 },
  ])("rejects a partial or inconsistent usage snapshot", (override) => {
    const valid = {
      plan: {
        effectivePlanId: "free",
        code: "free",
        kind: "free",
        source: "assignment",
        regularVideoLimit: 10,
        shortsVideoLimit: 10,
      },
      usage: {
        channelAnalysis: {
          daily: {
            used: 0,
            limit: 2,
            remaining: 2,
            resetAt: "2026-07-25T00:00:00.000Z",
          },
          monthly: {
            used: 0,
            limit: 5,
            remaining: 5,
            resetAt: "2026-08-01T00:00:00.000Z",
          },
        },
        aiConsult: {
          daily: {
            used: 0,
            limit: 1,
            remaining: 1,
            resetAt: "2026-07-25T00:00:00.000Z",
          },
          monthly: {
            used: 0,
            limit: 3,
            remaining: 3,
            resetAt: "2026-08-01T00:00:00.000Z",
          },
        },
      },
    };
    if ("plan" in override) valid.plan = { ...valid.plan, ...override.plan };
    if ("remaining" in override && typeof override.remaining === "number") {
      valid.usage.channelAnalysis.daily.remaining = override.remaining;
    }

    expect(parseUsageStatusResponse(valid)).toBeNull();
  });

  it("accepts a deduplicated owned-channel list and rejects arbitrary values", () => {
    expect(
      parseOwnedChannelsResponse({
        channels: [
          { id: "UCaaaaaaaaaaaaaaaaaaaaaa", title: "Primary" },
          { id: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "Secondary" },
        ],
      })
    ).toHaveLength(2);
    expect(
      parseOwnedChannelsResponse({
        channels: [{ id: "not-owned-or-valid", title: "Arbitrary" }],
      })
    ).toBeNull();
  });

  it.each([400, 401, 403, 409, 429, 500, 502, 504])(
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
      regularVideos: [{ id: "regular0001" }],
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

  it("classifies a valid zero-video response as an empty result, not an error", () => {
    const decision = evaluateChannelAnalysisResponse(200, {
      code: "NO_ANALYZABLE_VIDEOS",
      channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      channelTitle: "Test Channel",
      regularVideos: [],
      shortVideos: [],
    });

    expect(decision).toMatchObject({ accepted: false, kind: "empty" });
    expect(decision.accepted ? true : decision.kind).not.toBe("error");
  });

  it("does not accept an empty successful payload without the explicit empty code", () => {
    const decision = evaluateChannelAnalysisResponse(200, {
      analysisRunId: "3ecce3e0-2dd5-4b57-9a4a-f26b4c7793b3",
      channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      channelTitle: "Test Channel",
      regularVideos: [],
      shortVideos: [],
    });

    expect(decision).toMatchObject({ accepted: false, kind: "error" });
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

  it.each([
    [401, "ログインが必要です", "再ログイン"],
    [403, "所有チャンネルとして確認できません", "所有・管理権限"],
    [409, "同じ処理が実行中です", "操作を繰り返さず"],
    [500, "処理を完了できませんでした", "データ保存または内部処理"],
    [502, "外部サービスに接続できませんでした", "動画が0件の状態とは異なります"],
    [504, "通信が完了しませんでした", "利用枠の状態を自動確認"],
  ] as const)(
    "maps %s without exposing internal or secret values",
    (status, title, expectedMessage) => {
      const feedback = getSafeClientApiErrorFeedback(
        status,
        {
          error: "SQLSTATE 23505 postgresql://role:password@example.test/db",
          token: "secret-token",
        },
        "channel_analysis"
      );

      expect(feedback.title).toBe(title);
      expect(feedback.message).toContain(expectedMessage);
      expect(JSON.stringify(feedback)).not.toMatch(
        /SQLSTATE|postgresql|password|secret-token|23505/i
      );
    }
  );

  it.each([
    ["network", true, "利用枠の現在値は自動確認しました。"],
    ["timeout", false, "利用枠の現在値を確認できませんでした。"],
  ] as const)("maps a %s failure using the usage refresh result", (kind, confirmed, expected) => {
    const feedback = getSafeClientNetworkErrorFeedback(kind, confirmed);

    expect(feedback.message).toContain(expected);
    expect(feedback.message).toContain("同じ操作を連打せず");
    expect(feedback.retry).toBe("none");
  });
});
