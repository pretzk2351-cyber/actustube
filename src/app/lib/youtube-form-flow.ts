import { parseAISummary } from "./api-validation";

export type ClientApiOperation = "channel_analysis" | "ai_consult";

export type OwnedChannelOption = {
  id: string;
  title: string;
};

export type ClientUsagePeriod = {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
};

export type ClientUsageStatus = {
  plan: {
    effectivePlanId: string;
    code: string;
    kind: "free";
    source: "assignment" | "free_fallback";
    regularVideoLimit: number;
    shortsVideoLimit: number;
  };
  usage: {
    channelAnalysis: {
      daily: ClientUsagePeriod;
      monthly: ClientUsagePeriod;
    };
    aiConsult: {
      daily: ClientUsagePeriod;
      monthly: ClientUsagePeriod;
    };
  };
};

type ApiErrorPayload = {
  code?: unknown;
  dailyResetAt?: unknown;
  monthlyResetAt?: unknown;
};

export type ChannelAnalysisEnvelope = {
  analysisRunId: string;
  channelId: string;
  channelTitle: string;
  regularVideos?: unknown[];
  shortVideos?: unknown[];
};

export type ChannelAnalysisDecision =
  | { accepted: true; analysis: ChannelAnalysisEnvelope }
  | { accepted: false; message: string };

type AIConsultButtonState = {
  hasValidAnalysis: boolean;
  analysisLoading: boolean;
  consultLoading: boolean;
  usageReady?: boolean;
  hasAIUsageRemaining?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseUsagePeriod(value: unknown): ClientUsagePeriod | null {
  if (!isObject(value)) return null;
  if (
    !isNonnegativeInteger(value.used) ||
    !isNonnegativeInteger(value.limit) ||
    !isNonnegativeInteger(value.remaining) ||
    typeof value.resetAt !== "string" ||
    Number.isNaN(Date.parse(value.resetAt)) ||
    value.remaining !== Math.max((value.limit as number) - (value.used as number), 0)
  ) {
    return null;
  }

  return {
    used: value.used as number,
    limit: value.limit as number,
    remaining: value.remaining as number,
    resetAt: value.resetAt,
  };
}

export function parseUsageStatusResponse(
  value: unknown
): ClientUsageStatus | null {
  if (!isObject(value) || !isObject(value.plan) || !isObject(value.usage)) {
    return null;
  }

  const plan = value.plan;
  const channelAnalysis = isObject(value.usage.channelAnalysis)
    ? value.usage.channelAnalysis
    : null;
  const aiConsult = isObject(value.usage.aiConsult)
    ? value.usage.aiConsult
    : null;
  const analysisDaily = parseUsagePeriod(channelAnalysis?.daily);
  const analysisMonthly = parseUsagePeriod(channelAnalysis?.monthly);
  const aiDaily = parseUsagePeriod(aiConsult?.daily);
  const aiMonthly = parseUsagePeriod(aiConsult?.monthly);

  if (
    typeof plan.effectivePlanId !== "string" ||
    plan.effectivePlanId.length === 0 ||
    plan.effectivePlanId.length > 32 ||
    typeof plan.code !== "string" ||
    plan.code !== plan.effectivePlanId ||
    plan.kind !== "free" ||
    !["assignment", "free_fallback"].includes(String(plan.source)) ||
    !isNonnegativeInteger(plan.regularVideoLimit) ||
    !isNonnegativeInteger(plan.shortsVideoLimit) ||
    !analysisDaily ||
    !analysisMonthly ||
    !aiDaily ||
    !aiMonthly
  ) {
    return null;
  }

  return {
    plan: {
      effectivePlanId: plan.effectivePlanId,
      code: plan.code,
      kind: "free",
      source: plan.source as "assignment" | "free_fallback",
      regularVideoLimit: plan.regularVideoLimit as number,
      shortsVideoLimit: plan.shortsVideoLimit as number,
    },
    usage: {
      channelAnalysis: {
        daily: analysisDaily,
        monthly: analysisMonthly,
      },
      aiConsult: {
        daily: aiDaily,
        monthly: aiMonthly,
      },
    },
  };
}

export function parseOwnedChannelsResponse(
  value: unknown
): OwnedChannelOption[] | null {
  if (!isObject(value) || !Array.isArray(value.channels)) return null;

  const seen = new Set<string>();
  const channels: OwnedChannelOption[] = [];

  for (const candidate of value.channels) {
    if (
      !isObject(candidate) ||
      typeof candidate.id !== "string" ||
      !/^UC[A-Za-z0-9_-]{22}$/.test(candidate.id) ||
      typeof candidate.title !== "string" ||
      candidate.title.length > 200 ||
      seen.has(candidate.id)
    ) {
      return null;
    }
    seen.add(candidate.id);
    channels.push({ id: candidate.id, title: candidate.title });
  }

  return channels;
}

export function hasUsageRemaining(periods: {
  daily: ClientUsagePeriod;
  monthly: ClientUsagePeriod;
}) {
  return periods.daily.remaining > 0 && periods.monthly.remaining > 0;
}

export function isUsableChannelAnalysis(
  value: unknown
): value is ChannelAnalysisEnvelope {
  if (
    !isObject(value) ||
    typeof value.analysisRunId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.analysisRunId
    ) ||
    typeof value.channelId !== "string" ||
    !/^UC[A-Za-z0-9_-]{22}$/.test(value.channelId) ||
    typeof value.channelTitle !== "string"
  ) {
    return false;
  }

  const channelTitle = value.channelTitle.trim();
  if (channelTitle.length === 0 || channelTitle.length > 200) return false;

  return (
    (value.regularVideos === undefined || Array.isArray(value.regularVideos)) &&
    (value.shortVideos === undefined || Array.isArray(value.shortVideos))
  );
}

export function canRequestAIConsult(aiSummary: unknown) {
  try {
    parseAISummary(aiSummary);
    return true;
  } catch {
    return false;
  }
}

export function isAIConsultButtonDisabled({
  hasValidAnalysis,
  analysisLoading,
  consultLoading,
  usageReady = true,
  hasAIUsageRemaining = true,
}: AIConsultButtonState) {
  return (
    !hasValidAnalysis ||
    analysisLoading ||
    consultLoading ||
    !usageReady ||
    !hasAIUsageRemaining
  );
}

function formatJapaneseResetAt(value: unknown) {
  if (typeof value !== "string") return null;

  const resetAt = new Date(value);
  if (Number.isNaN(resetAt.getTime())) return null;

  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(resetAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}年${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}（日本時間）`;
}

function usageLimitMessage(payload: ApiErrorPayload) {
  if (payload.code === "DAILY_USAGE_LIMIT_REACHED") {
    const resetAt = formatJapaneseResetAt(payload.dailyResetAt);
    return [
      "本日の利用上限に達しました。リセット後にもう一度お試しください。",
      resetAt ? `次回は${resetAt}から利用できます。` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (payload.code === "MONTHLY_USAGE_LIMIT_REACHED") {
    const resetAt = formatJapaneseResetAt(payload.monthlyResetAt);
    return [
      "今月の利用上限に達しました。",
      resetAt ? `次回は${resetAt}から利用できます。` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return "利用上限に達しました。リセット後にもう一度お試しください。";
}

export function getSafeClientApiErrorMessage(
  status: number,
  payload: unknown,
  operation: ClientApiOperation
) {
  const errorPayload = isObject(payload) ? payload : {};

  if (status === 429) return usageLimitMessage(errorPayload);

  if (status === 400) {
    return operation === "channel_analysis"
      ? "チャンネルURLを確認してください。"
      : "AI提案に必要な分析結果が無効です。チャンネルを再分析してください。";
  }

  if (status === 401) {
    return "認証の有効期限が切れています。再ログインしてください。";
  }

  if (status === 403) {
    return "この機能は現在利用できません。アカウントまたはプランをご確認ください。";
  }

  if (status >= 500) {
    return operation === "channel_analysis"
      ? "チャンネル分析に失敗しました。時間をおいてもう一度お試しください。"
      : "AI提案の生成に失敗しました。時間をおいてもう一度お試しください。";
  }

  return operation === "channel_analysis"
    ? "チャンネル分析に失敗しました。"
    : "AI提案の生成に失敗しました。";
}

export function evaluateChannelAnalysisResponse(
  status: number,
  payload: unknown
): ChannelAnalysisDecision {
  if (status < 200 || status >= 300) {
    return {
      accepted: false,
      message: getSafeClientApiErrorMessage(
        status,
        payload,
        "channel_analysis"
      ),
    };
  }

  if (!isUsableChannelAnalysis(payload)) {
    return {
      accepted: false,
      message: "有効なチャンネル分析結果を取得できませんでした。",
    };
  }

  return { accepted: true, analysis: payload };
}
