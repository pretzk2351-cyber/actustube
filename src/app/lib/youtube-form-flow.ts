import { parseAISummary } from "./api-validation";

export type ClientApiOperation =
  | "channel_analysis"
  | "ai_consult"
  | "owned_channels"
  | "usage_status";

export type ClientErrorFeedback = {
  title: string;
  message: string;
  requiresUsageRefresh: boolean;
  retry: "none" | "after_reset" | "reauthenticate" | "check_permissions";
};

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

export type EmptyChannelAnalysisEnvelope = {
  code: "NO_ANALYZABLE_VIDEOS";
  channelId: string;
  channelTitle: string;
  regularVideos: [];
  shortVideos: [];
};

export type ChannelAnalysisDecision =
  | { accepted: true; kind: "analysis"; analysis: ChannelAnalysisEnvelope }
  | { accepted: false; kind: "empty"; empty: EmptyChannelAnalysisEnvelope }
  | {
      accepted: false;
      kind: "error";
      feedback: ClientErrorFeedback;
      message: string;
    };

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

  const regularVideos = Array.isArray(value.regularVideos)
    ? value.regularVideos
    : [];
  const shortVideos = Array.isArray(value.shortVideos) ? value.shortVideos : [];

  return regularVideos.length + shortVideos.length > 0;
}

function parseEmptyChannelAnalysis(
  value: unknown
): EmptyChannelAnalysisEnvelope | null {
  if (
    !isObject(value) ||
    value.code !== "NO_ANALYZABLE_VIDEOS" ||
    typeof value.channelId !== "string" ||
    !/^UC[A-Za-z0-9_-]{22}$/.test(value.channelId) ||
    typeof value.channelTitle !== "string" ||
    value.channelTitle.trim().length === 0 ||
    value.channelTitle.trim().length > 200 ||
    !Array.isArray(value.regularVideos) ||
    value.regularVideos.length !== 0 ||
    !Array.isArray(value.shortVideos) ||
    value.shortVideos.length !== 0
  ) {
    return null;
  }

  return value as EmptyChannelAnalysisEnvelope;
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
  return getSafeClientApiErrorFeedback(status, payload, operation).message;
}

export function getSafeClientApiErrorFeedback(
  status: number,
  payload: unknown,
  operation: ClientApiOperation
): ClientErrorFeedback {
  const errorPayload = isObject(payload) ? payload : {};

  if (status === 429) {
    const monthly = errorPayload.code === "MONTHLY_USAGE_LIMIT_REACHED";
    return {
      title: monthly ? "今月の利用枠に達しました" : "本日の利用枠に達しました",
      message: usageLimitMessage(errorPayload),
      requiresUsageRefresh: false,
      retry: "after_reset",
    };
  }

  if (status === 400) {
    return {
      title: "入力内容を確認してください",
      message:
        operation === "channel_analysis"
          ? "選択したチャンネルを確認してください。"
          : operation === "ai_consult"
            ? "AI提案に必要な分析結果が無効です。チャンネルを再分析してください。"
            : "入力内容を確認して、もう一度操作してください。",
      requiresUsageRefresh: false,
      retry: "none",
    };
  }

  if (status === 401) {
    return {
      title: "ログインが必要です",
      message:
        "認証の有効期限が切れている可能性があります。ページを再読み込みし、Googleアカウントで再ログインしてください。",
      requiresUsageRefresh: false,
      retry: "reauthenticate",
    };
  }

  if (status === 403) {
    return operation === "channel_analysis" || operation === "owned_channels"
      ? {
          title: "所有チャンネルとして確認できません",
          message:
            "ログイン中のGoogleアカウントと、対象チャンネルの所有・管理権限を確認してください。動画が0件の状態とは異なります。",
          requiresUsageRefresh: false,
          retry: "check_permissions",
        }
      : {
          title: "この機能を利用できません",
          message:
            "ログイン中のGoogleアカウントと、現在のプランまたは権限を確認してください。",
          requiresUsageRefresh: false,
          retry: "check_permissions",
        };
  }

  if (status === 409) {
    return {
      title: "同じ処理が実行中です",
      message:
        "別の処理が完了していない可能性があります。操作を繰り返さず、少し待ってから画面を再確認してください。",
      requiresUsageRefresh: false,
      retry: "none",
    };
  }

  if (status === 502) {
    return {
      title: "外部サービスに接続できませんでした",
      message:
        operation === "ai_consult"
          ? "AIサービスへの接続に失敗しました。動画が0件の状態とは異なります。操作を連打せず、時間をおいて画面を再確認してください。"
          : "YouTubeへの接続に失敗しました。動画が0件の状態とは異なります。操作を連打せず、時間をおいて画面を再確認してください。",
      requiresUsageRefresh: false,
      retry: "none",
    };
  }

  if (status === 504) {
    return {
      title: "通信が完了しませんでした",
      message:
        "処理が制限時間内に完了しませんでした。利用枠の状態を自動確認するため、同じ操作を繰り返さずお待ちください。",
      requiresUsageRefresh: true,
      retry: "none",
    };
  }

  if (status >= 500) {
    if (operation === "usage_status") {
      return {
        title: "利用枠を確認できません",
        message:
          "利用枠を確認できませんでした。安全のため分析とAI提案を停止しています。",
        requiresUsageRefresh: false,
        retry: "none",
      };
    }

    if (operation === "owned_channels") {
      return {
        title: "所有チャンネルを確認できません",
        message:
          "所有チャンネルを取得できませんでした。任意入力では分析できません。",
        requiresUsageRefresh: false,
        retry: "none",
      };
    }

    return {
      title: "処理を完了できませんでした",
      message:
        "データ保存または内部処理に失敗しました。同じ操作を連打せず、画面を再読み込みして利用枠と履歴を確認してください。",
      requiresUsageRefresh: false,
      retry: "none",
    };
  }

  return {
    title: "処理を完了できませんでした",
    message:
      operation === "ai_consult"
        ? "AI提案を作成できませんでした。画面を再確認してください。"
        : "チャンネル分析を完了できませんでした。画面を再確認してください。",
    requiresUsageRefresh: false,
    retry: "none",
  };
}

export function getSafeClientNetworkErrorFeedback(
  kind: "network" | "timeout",
  usageStatusConfirmed: boolean
): ClientErrorFeedback {
  const confirmation = usageStatusConfirmed
    ? "利用枠の現在値は自動確認しました。"
    : "利用枠の現在値を確認できませんでした。";

  return {
    title:
      kind === "timeout"
        ? "通信が制限時間内に完了しませんでした"
        : "通信を完了できませんでした",
    message: `${confirmation} 処理結果が不明なため、同じ操作を連打せず、画面を再読み込みして履歴を確認してください。`,
    requiresUsageRefresh: false,
    retry: "none",
  };
}

export function evaluateChannelAnalysisResponse(
  status: number,
  payload: unknown
): ChannelAnalysisDecision {
  if (status < 200 || status >= 300) {
    const feedback = getSafeClientApiErrorFeedback(
      status,
      payload,
      "channel_analysis"
    );
    return {
      accepted: false,
      kind: "error",
      feedback,
      message: feedback.message,
    };
  }

  const empty = parseEmptyChannelAnalysis(payload);
  if (empty) {
    return { accepted: false, kind: "empty", empty };
  }

  if (!isUsableChannelAnalysis(payload)) {
    const feedback: ClientErrorFeedback = {
      title: "分析結果を確認できませんでした",
      message:
        "有効なチャンネル分析結果を取得できませんでした。同じ操作を連打せず、画面を再読み込みしてください。",
      requiresUsageRefresh: false,
      retry: "none",
    };
    return {
      accepted: false,
      kind: "error",
      feedback,
      message: feedback.message,
    };
  }

  return { accepted: true, kind: "analysis", analysis: payload };
}
