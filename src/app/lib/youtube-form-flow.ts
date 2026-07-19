import { parseAISummary } from "./api-validation";

export type ClientApiOperation = "channel_analysis" | "ai_consult";

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
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
}: AIConsultButtonState) {
  return !hasValidAnalysis || analysisLoading || consultLoading;
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
