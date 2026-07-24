"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { WeeklyImprovementCycle } from "@/app/components/weekly-improvement-cycle";
import {
  AnalysisFlowGuide,
  SectionIntro,
  StatusPanel,
} from "@/app/components/ui-foundation";

import {
  canRequestAIConsult,
  evaluateChannelAnalysisResponse,
  getSafeClientApiErrorMessage,
  hasUsageRemaining,
  isAIConsultButtonDisabled,
  parseOwnedChannelsResponse,
  parseUsageStatusResponse,
  type ClientUsageStatus,
  type OwnedChannelOption,
} from "@/app/lib/youtube-form-flow";

type Video = {
  id: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: string;
  duration?: string;
  durationSeconds?: number;
  isShort?: boolean;
};

type VideoWithMetrics = Video & {
  viewCountNumber: number;
  publishedAtDate: Date;
  titleLength: number;
};

type Analysis = {
  averageViews: number;
  topVideo: VideoWithMetrics | null;
  lowVideo: VideoWithMetrics | null;
  postingFrequency: string;
  medianViews: number;
  totalViews: number;
} | null;

type AIConsultResult = {
  overallDiagnosis: string;
  strongPoints: string[];
  weakPoints: string[];
  currentImprovements: string[];
  nextSuggestions: string[];
};

type ChannelAnalysisResult = {
  analysisRunId: string;
  channelId: string;
  channelTitle: string;
  regularVideos: Video[];
  shortVideos: Video[];
};

const EMPTY_VIDEOS: Video[] = [];

function normalizeVideos(videos: Video[]): VideoWithMetrics[] {
  return videos.map((video) => ({
    ...video,
    viewCountNumber: Number(video.viewCount),
    publishedAtDate: new Date(video.publishedAt),
    titleLength: video.title.length,
  }));
}

function getMedian(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function getAnalysis(videos: Video[]): Analysis {
  if (videos.length === 0) return null;

  const normalized = normalizeVideos(videos);

  const totalViews = normalized.reduce(
    (sum, video) => sum + video.viewCountNumber,
    0
  );

  const averageViews = Math.round(totalViews / normalized.length);
  const medianViews = getMedian(normalized.map((video) => video.viewCountNumber));

  const topVideo = normalized.reduce((max, video) =>
    video.viewCountNumber > max.viewCountNumber ? video : max
  );

  const lowVideo = normalized.reduce((min, video) =>
    video.viewCountNumber < min.viewCountNumber ? video : min
  );

  const sortedByDate = [...normalized].sort(
    (a, b) => b.publishedAtDate.getTime() - a.publishedAtDate.getTime()
  );

  let postingFrequency = "判定不可";

  if (sortedByDate.length >= 2) {
    let totalDiffDays = 0;

    for (let i = 0; i < sortedByDate.length - 1; i++) {
      const current = sortedByDate[i].publishedAtDate.getTime();
      const next = sortedByDate[i + 1].publishedAtDate.getTime();
      const diffDays = Math.abs(current - next) / (1000 * 60 * 60 * 24);
      totalDiffDays += diffDays;
    }

    const avgDiffDays = totalDiffDays / (sortedByDate.length - 1);

    if (avgDiffDays <= 3) {
      postingFrequency = "かなり高い";
    } else if (avgDiffDays <= 7) {
      postingFrequency = "高め";
    } else if (avgDiffDays <= 14) {
      postingFrequency = "普通";
    } else {
      postingFrequency = "低め";
    }
  }

  return {
    averageViews,
    topVideo,
    lowVideo,
    postingFrequency,
    medianViews,
    totalViews,
  };
}

function buildAISummary(
  channelTitle: string,
  regularVideos: Video[],
  shortVideos: Video[],
  regularAnalysis: Analysis,
  shortAnalysis: Analysis
) {
  return {
    channelTitle,
    regular: {
      count: regularVideos.length,
      averageViews: regularAnalysis?.averageViews ?? 0,
      postingFrequency: regularAnalysis?.postingFrequency ?? "判定不可",
      topVideo: regularAnalysis?.topVideo
        ? {
            title: regularAnalysis.topVideo.title,
            views: regularAnalysis.topVideo.viewCountNumber,
          }
        : null,
      lowVideo: regularAnalysis?.lowVideo
        ? {
            title: regularAnalysis.lowVideo.title,
            views: regularAnalysis.lowVideo.viewCountNumber,
          }
        : null,
      videos: regularVideos.map((video) => ({
        title: video.title,
        views: Number(video.viewCount),
        publishedAt: video.publishedAt,
      })),
    },
    shorts: {
      count: shortVideos.length,
      averageViews: shortAnalysis?.averageViews ?? 0,
      postingFrequency: shortAnalysis?.postingFrequency ?? "判定不可",
      topVideo: shortAnalysis?.topVideo
        ? {
            title: shortAnalysis.topVideo.title,
            views: shortAnalysis.topVideo.viewCountNumber,
          }
        : null,
      lowVideo: shortAnalysis?.lowVideo
        ? {
            title: shortAnalysis.lowVideo.title,
            views: shortAnalysis.lowVideo.viewCountNumber,
          }
        : null,
      videos: shortVideos.map((video) => ({
        title: video.title,
        views: Number(video.viewCount),
        publishedAt: video.publishedAt,
      })),
    },
  };
}

function getTopVideos(videos: Video[], count: number) {
  return normalizeVideos(videos)
    .sort((a, b) => b.viewCountNumber - a.viewCountNumber)
    .slice(0, count);
}

function getLowVideos(videos: Video[], count: number) {
  return normalizeVideos(videos)
    .sort((a, b) => a.viewCountNumber - b.viewCountNumber)
    .slice(0, count);
}

function getMonthlyBuckets(videos: Video[]) {
  const map = new Map<string, number>();

  for (const video of videos) {
    const date = new Date(video.publishedAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
    map.set(key, (map.get(key) ?? 0) + Number(video.viewCount));
  }

  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([label, value]) => ({ label, value }));
}

function getSimpleBarWidth(value: number, max: number) {
  if (max <= 0) return "0%";
  return `${Math.max(4, Math.round((value / max) * 100))}%`;
}

function getPerformanceBands(videos: Video[], analysis: Analysis) {
  if (!analysis || videos.length === 0) {
    return [
      { label: "高い", value: 0 },
      { label: "中間", value: 0 },
      { label: "低い", value: 0 },
    ];
  }

  let high = 0;
  let mid = 0;
  let low = 0;

  for (const video of videos) {
    const views = Number(video.viewCount);
    if (views >= analysis.averageViews * 1.2) high += 1;
    else if (views <= analysis.averageViews * 0.8) low += 1;
    else mid += 1;
  }

  return [
    { label: "高い", value: high },
    { label: "中間", value: mid },
    { label: "低い", value: low },
  ];
}

function describePostingFrequency(value: string) {
  if (value === "かなり高い") return "投稿間隔が短く、検証回数を回しやすい状態です。";
  if (value === "高め") return "投稿頻度は十分で、企画精度の改善が効きやすい状態です。";
  if (value === "普通") return "頻度は標準的です。企画と見せ方の改善余地を見やすい状態です。";
  if (value === "低め") return "投稿間隔が広く、改善サイクルが遅くなりやすい状態です。";
  return "データが不足しています。";
}

function DonutChart({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: number; color: string }[];
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div
      className="youtube-donut-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: "18px",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "160px",
          height: "160px",
          position: "relative",
          display: "grid",
          placeItems: "center",
        }}
      >
        <svg width="160" height="160" viewBox="0 0 160 160">
          <g transform="rotate(-90 80 80)">
            {items.map((item, index) => {
              const segment = total > 0 ? (item.value / total) * circumference : 0;
              const circle = (
                <circle
                  key={`${item.label}-${index}`}
                  cx="80"
                  cy="80"
                  r={radius}
                  fill="transparent"
                  stroke={item.color}
                  strokeWidth="20"
                  strokeDasharray={`${segment} ${circumference - segment}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += segment;
              return circle;
            })}
          </g>
        </svg>

        <div
          style={{
            position: "absolute",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              color: "#6b7280",
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: "30px",
              fontWeight: 900,
              letterSpacing: "-0.04em",
              marginTop: "4px",
            }}
          >
            {total}
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "#6b7280",
              marginTop: "2px",
            }}
          >
            本
          </div>
        </div>
      </div>

      <div className="youtube-donut-legend">
        {items.map((item) => {
          const ratio = total > 0 ? Math.round((item.value / total) * 100) : 0;
          return (
            <div
              key={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
                marginBottom: "12px",
                paddingBottom: "12px",
                borderBottom: "1px solid #f0f0f0",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span
                  style={{
                    width: "12px",
                    height: "12px",
                    borderRadius: "999px",
                    backgroundColor: item.color,
                    display: "inline-block",
                  }}
                />
                <span style={{ fontWeight: 700 }}>{item.label}</span>
              </div>
              <div
                style={{
                  fontSize: "14px",
                  color: "#4b5563",
                  fontWeight: 700,
                }}
              >
                {item.value} 本 / {ratio}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  page: {
    width: "100%",
    maxWidth: "1180px",
    margin: "0 auto",
  } as const,
  inputBar: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    flexWrap: "wrap" as const,
    marginBottom: "24px",
  },
  prefixWrap: {
    display: "flex",
    alignItems: "center",
    flex: "1 1 320px",
    minWidth: 0,
    width: "100%",
    border: "1px solid var(--color-border-strong)",
    borderRadius: "16px",
    overflow: "hidden",
    backgroundColor: "var(--color-surface)",
  } as const,
  prefix: {
    padding: "15px 14px 15px 16px",
    backgroundColor: "var(--color-surface-muted)",
    color: "var(--color-text-muted)",
    fontSize: "14px",
    fontWeight: 700,
    borderRight: "1px solid #ededed",
    whiteSpace: "nowrap" as const,
  } as const,
  input: {
    flex: 1,
    minWidth: 0,
    width: "100%",
    padding: "15px 16px",
    border: "none",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text)",
    fontSize: "15px",
    outline: "none",
  } as const,
  button: {
    padding: "15px 20px",
    borderRadius: "16px",
    border: "1px solid var(--color-accent)",
    backgroundColor: "var(--color-accent)",
    color: "#ffffff",
    fontWeight: 800,
    cursor: "pointer",
  } as const,
  consultButton: {
    padding: "15px 20px",
    borderRadius: "16px",
    fontWeight: 800,
  } as const,
  consultAction: {
    position: "relative" as const,
  } as const,
  consultHint: {
    position: "absolute" as const,
    top: "calc(100% + 5px)",
    left: 0,
    margin: 0,
    color: "#4b5563",
    fontSize: "12px",
    fontWeight: 700,
    lineHeight: 1.4,
    whiteSpace: "nowrap" as const,
  } as const,
  section: {
    backgroundColor: "#ffffff",
    border: "1px solid var(--color-border)",
    borderRadius: "20px",
    padding: "24px",
    marginBottom: "22px",
    boxShadow: "var(--shadow-card)",
  } as const,
  sectionTitle: {
    marginTop: 0,
    marginBottom: "14px",
    fontSize: "24px",
    fontWeight: 850,
    letterSpacing: "-0.03em",
  } as const,
  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "22px",
    marginBottom: "22px",
  } as const,
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "18px",
    marginBottom: "22px",
  } as const,
  statCard: {
    border: "1px solid var(--color-border)",
    borderRadius: "20px",
    padding: "20px",
    background: "var(--color-surface-muted)",
  } as const,
  cardRed: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderTop: "4px solid var(--color-accent)",
    borderRadius: "20px",
    padding: "24px",
    boxShadow: "var(--shadow-card)",
  } as const,
  cardBlack: {
    background: "var(--color-dark)",
    color: "#ffffff",
    borderRadius: "20px",
    padding: "24px",
    boxShadow: "var(--shadow-card)",
  } as const,
  list: {
    margin: 0,
    paddingLeft: "20px",
    lineHeight: 1.95,
  } as const,
  smallLabel: {
    margin: 0,
    fontSize: "12px",
    fontWeight: 800,
    letterSpacing: "0.05em",
    color: "var(--color-accent)",
    textTransform: "uppercase" as const,
  } as const,
  prose: {
    margin: 0,
    lineHeight: 1.95,
    color: "var(--color-text)",
    fontSize: "15px",
  } as const,
  darkProse: {
    margin: 0,
    lineHeight: 1.95,
    color: "#f5f5f5",
    fontSize: "15px",
  } as const,
  tableWrap: {
    width: "100%",
    overflowX: "auto" as const,
    border: "1px solid var(--color-border)",
    borderRadius: "18px",
  } as const,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    minWidth: "760px",
    backgroundColor: "var(--color-surface)",
  } as const,
  th: {
    textAlign: "left" as const,
    padding: "14px 16px",
    backgroundColor: "#111111",
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: 800,
    letterSpacing: "0.04em",
  } as const,
  td: {
    padding: "14px 16px",
    borderBottom: "1px solid #efefef",
    verticalAlign: "top" as const,
    fontSize: "14px",
    lineHeight: 1.7,
  } as const,
  barTrack: {
    width: "100%",
    height: "12px",
    backgroundColor: "#f1f1f1",
    borderRadius: "999px",
    overflow: "hidden",
    marginTop: "8px",
  } as const,
  barFillBlack: {
    height: "100%",
    background: "var(--color-dark)",
    borderRadius: "999px",
  } as const,
  barFillRed: {
    height: "100%",
    background: "var(--color-accent)",
    borderRadius: "999px",
  } as const,
};

export function YouTubeForm() {
  const [ownedChannels, setOwnedChannels] = useState<OwnedChannelOption[]>([]);
  const [selectedOwnedChannelId, setSelectedOwnedChannelId] = useState("");
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState("");
  const [usageStatus, setUsageStatus] = useState<ClientUsageStatus | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState("");
  const [loading, setLoading] = useState(false);
  const [analysisResult, setAnalysisResult] =
    useState<ChannelAnalysisResult | null>(null);
  const [error, setError] = useState("");
  const [consultLoading, setConsultLoading] = useState(false);
  const [consultError, setConsultError] = useState("");
  const [consult, setConsult] = useState<AIConsultResult | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const channelTitle = analysisResult?.channelTitle ?? "";
  const regularVideos = analysisResult?.regularVideos ?? EMPTY_VIDEOS;
  const shortVideos = analysisResult?.shortVideos ?? EMPTY_VIDEOS;

  const loadUsageStatus = useCallback(async (signal?: AbortSignal) => {
    setUsageLoading(true);
    setUsageError("");

    try {
      const response = await fetch("/api/usage/status", {
        cache: "no-store",
        signal,
      });
      const data = (await response.json()) as unknown;
      const parsed = response.ok ? parseUsageStatusResponse(data) : null;
      if (!parsed) throw new Error("UsageStatusUnavailable");
      if (signal?.aborted) return false;
      setUsageStatus(parsed);
      return true;
    } catch {
      if (signal?.aborted) return false;
      setUsageStatus(null);
      setUsageError(
        "利用枠を確認できませんでした。安全のため分析とAI提案を停止しています。"
      );
      return false;
    } finally {
      if (!signal?.aborted) setUsageLoading(false);
    }
  }, []);

  const loadOwnedChannels = useCallback(async (signal?: AbortSignal) => {
    setChannelsLoading(true);
    setChannelsError("");

    try {
      const response = await fetch("/api/youtube/my-channels", {
        cache: "no-store",
        signal,
      });
      const data = (await response.json()) as unknown;
      const channels = response.ok ? parseOwnedChannelsResponse(data) : null;
      if (!channels) throw new Error("OwnedChannelsUnavailable");
      if (signal?.aborted) return;
      setOwnedChannels(channels);
      setSelectedOwnedChannelId(channels.length === 1 ? channels[0].id : "");
    } catch {
      if (signal?.aborted) return;
      setOwnedChannels([]);
      setSelectedOwnedChannelId("");
      setChannelsError(
        "所有チャンネルを取得できませんでした。任意入力では分析できません。"
      );
    } finally {
      if (!signal?.aborted) setChannelsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUsageStatus(controller.signal);
    void loadOwnedChannels(controller.signal);
    return () => controller.abort();
  }, [loadOwnedChannels, loadUsageStatus]);

  const handleOwnedChannelChange = (channelId: string) => {
    setSelectedOwnedChannelId(channelId);
    setAnalysisResult(null);
    setConsult(null);
    setError("");
    setConsultError("");
  };

  const handleFetch = async () => {
    if (!selectedOwnedChannelId || !usageStatus) {
      setError(
        "所有チャンネルと利用枠を確認できるまで分析を開始できません。"
      );
      return;
    }

    setLoading(true);
    setError("");
    setAnalysisResult(null);
    setConsult(null);
    setConsultError("");

    try {
      const res = await fetch(
        `/api/youtube/channel?channelId=${encodeURIComponent(selectedOwnedChannelId)}`
      );

      const text = await res.text();

      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        setError("チャンネル分析に失敗しました。時間をおいてもう一度お試しください。");
        return;
      }

      const decision = evaluateChannelAnalysisResponse(res.status, data);
      if (!decision.accepted) {
        setError(decision.message);
        return;
      }

      setAnalysisResult({
        analysisRunId: decision.analysis.analysisRunId,
        channelId: decision.analysis.channelId,
        channelTitle: decision.analysis.channelTitle.trim(),
        regularVideos: (decision.analysis.regularVideos ?? []) as Video[],
        shortVideos: (decision.analysis.shortVideos ?? []) as Video[],
      });
      setHistoryRefreshKey((current) => current + 1);
      await loadUsageStatus();
    } catch {
      setError("チャンネル分析に失敗しました。時間をおいてもう一度お試しください。");
    } finally {
      setLoading(false);
    }
  };

  const regularAnalysis = getAnalysis(regularVideos);
  const shortAnalysis = getAnalysis(shortVideos);

  const consultPayload = useMemo(
    () => {
      if (!analysisResult) return null;

      const candidate = buildAISummary(
        channelTitle,
        regularVideos,
        shortVideos,
        regularAnalysis,
        shortAnalysis
      );

      return canRequestAIConsult(candidate) ? candidate : null;
    },
    [
      analysisResult,
      channelTitle,
      regularVideos,
      shortVideos,
      regularAnalysis,
      shortAnalysis,
    ]
  );

  const handleConsult = async () => {
    if (
      !consultPayload ||
      !usageStatus ||
      !hasUsageRemaining(usageStatus.usage.aiConsult)
    ) {
      setConsultError(
        "有効な分析結果と利用可能なAI提案枠を確認できません。"
      );
      return;
    }

    setConsultLoading(true);
    setConsultError("");
    setConsult(null);

    try {
      const res = await fetch("/api/ai-consult", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          aiSummary: consultPayload,
          analysisRunId: analysisResult?.analysisRunId,
        }),
      });

      const text = await res.text();

      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        setConsultError(
          "AI提案の生成に失敗しました。時間をおいてもう一度お試しください。"
        );
        return;
      }

      if (!res.ok) {
        setConsultError(
          getSafeClientApiErrorMessage(res.status, data, "ai_consult")
        );
        return;
      }

      setConsult(data as AIConsultResult);
      setHistoryRefreshKey((current) => current + 1);
      await loadUsageStatus();
    } catch {
      setConsultError(
        "AI提案の生成に失敗しました。時間をおいてもう一度お試しください。"
      );
    } finally {
      setConsultLoading(false);
    }
  };

  const regularTop10 = useMemo(() => getTopVideos(regularVideos, 10), [regularVideos]);
  const shortTop10 = useMemo(() => getTopVideos(shortVideos, 10), [shortVideos]);
  const regularLow5 = useMemo(() => getLowVideos(regularVideos, 5), [regularVideos]);
  const shortLow5 = useMemo(() => getLowVideos(shortVideos, 5), [shortVideos]);

  const regularBuckets = useMemo(() => getMonthlyBuckets(regularVideos), [regularVideos]);
  const shortBuckets = useMemo(() => getMonthlyBuckets(shortVideos), [shortVideos]);

  const regularBucketMax = Math.max(...regularBuckets.map((b) => b.value), 1);
  const shortBucketMax = Math.max(...shortBuckets.map((b) => b.value), 1);

  const regularBands = useMemo(
    () => getPerformanceBands(regularVideos, regularAnalysis),
    [regularVideos, regularAnalysis]
  );
  const shortBands = useMemo(
    () => getPerformanceBands(shortVideos, shortAnalysis),
    [shortVideos, shortAnalysis]
  );
  const selectedOwnedChannel = ownedChannels.find(
    (channel) => channel.id === selectedOwnedChannelId
  );
  const analysisUsageRemaining = usageStatus
    ? hasUsageRemaining(usageStatus.usage.channelAnalysis)
    : false;
  const aiUsageRemaining = usageStatus
    ? hasUsageRemaining(usageStatus.usage.aiConsult)
    : false;
  const analysisDisabled =
    loading ||
    consultLoading ||
    channelsLoading ||
    usageLoading ||
    !selectedOwnedChannel ||
    !usageStatus ||
    !analysisUsageRemaining;
  const consultDisabled = isAIConsultButtonDisabled({
    hasValidAnalysis: consultPayload !== null,
    analysisLoading: loading,
    consultLoading,
    usageReady: !usageLoading && usageStatus !== null,
    hasAIUsageRemaining: aiUsageRemaining,
  });

  return (
    <div style={styles.page}>
      <section
        className="youtube-preflight-grid"
        aria-label="分析前の利用枠と所有チャンネル確認"
      >
        <div className="youtube-preflight-card youtube-preflight-card--usage">
          <p style={styles.smallLabel}>Usage status</p>
          <h2 className="youtube-preflight-title">現在の利用枠</h2>
          {usageLoading && <p role="status">利用枠を確認しています...</p>}
          {!usageLoading && usageStatus && (
            <>
              <p className="youtube-plan-label">
                Plan: <strong>{usageStatus.plan.code}</strong>
              </p>
              <div className="youtube-quota-grid">
                <div>
                  <span>分析・日次</span>
                  <strong>
                    {usageStatus.usage.channelAnalysis.daily.remaining} /{" "}
                    {usageStatus.usage.channelAnalysis.daily.limit}
                  </strong>
                </div>
                <div>
                  <span>分析・月次</span>
                  <strong>
                    {usageStatus.usage.channelAnalysis.monthly.remaining} /{" "}
                    {usageStatus.usage.channelAnalysis.monthly.limit}
                  </strong>
                </div>
                <div>
                  <span>AI提案・日次</span>
                  <strong>
                    {usageStatus.usage.aiConsult.daily.remaining} /{" "}
                    {usageStatus.usage.aiConsult.daily.limit}
                  </strong>
                </div>
                <div>
                  <span>AI提案・月次</span>
                  <strong>
                    {usageStatus.usage.aiConsult.monthly.remaining} /{" "}
                    {usageStatus.usage.aiConsult.monthly.limit}
                  </strong>
                </div>
              </div>
              <p className="youtube-video-limits">
                1回の処理上限：通常動画{" "}
                {usageStatus.plan.regularVideoLimit}本／Shorts{" "}
                {usageStatus.plan.shortsVideoLimit}本
              </p>
            </>
          )}
        </div>

        <div className="youtube-preflight-card">
          <p style={styles.smallLabel}>Owned channel</p>
          <h2 className="youtube-preflight-title">分析する所有チャンネル</h2>
          {channelsLoading && <p role="status">所有チャンネルを確認しています...</p>}
          {!channelsLoading && !channelsError && ownedChannels.length === 0 && (
            <p>分析できる所有チャンネルが見つかりません。</p>
          )}
          {!channelsLoading && ownedChannels.length === 1 && selectedOwnedChannel && (
            <p className="youtube-selected-channel">
              選択済み：<strong>{selectedOwnedChannel.title || "所有チャンネル"}</strong>
            </p>
          )}
          {!channelsLoading && ownedChannels.length > 1 && (
            <div className="youtube-channel-select-wrap">
              <label htmlFor="owned-youtube-channel">所有チャンネルを選択</label>
              <select
                id="owned-youtube-channel"
                value={selectedOwnedChannelId}
                onChange={(event) =>
                  handleOwnedChannelChange(event.target.value)
                }
                disabled={loading || consultLoading}
              >
                <option value="">選択してください</option>
                {ownedChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title || "所有チャンネル"}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      <div className="youtube-input-bar" style={styles.inputBar}>
        <button
          type="button"
          className="button button--primary"
          onClick={handleFetch}
          style={styles.button}
          disabled={analysisDisabled}
          aria-disabled={analysisDisabled}
          aria-busy={loading}
          aria-describedby="analysis-availability-hint"
        >
          {loading ? "分析中..." : "分析する"}
        </button>

        <div className="youtube-consult-action" style={styles.consultAction}>
          <button
            type="button"
            className="ai-consult-button"
            onClick={handleConsult}
            style={styles.consultButton}
            disabled={consultDisabled}
            aria-disabled={consultDisabled}
            aria-busy={consultLoading}
            aria-describedby={
              consultDisabled ? "ai-consult-availability-hint" : undefined
            }
          >
            {consultLoading ? "提案を作成中..." : "提案を見る"}
          </button>
          {consultDisabled && (
            <p
              id="ai-consult-availability-hint"
              className="youtube-consult-hint"
              style={styles.consultHint}
            >
              {!usageStatus || usageLoading
                ? "利用枠の確認後に利用できます"
                : !aiUsageRemaining
                  ? "AI提案の利用枠がありません"
                  : "チャンネル分析後に利用できます"}
            </p>
          )}
        </div>
      </div>

      <p id="analysis-availability-hint" className="youtube-action-hint">
        {!usageStatus || usageLoading
          ? "利用枠の確認後に分析できます。"
          : !analysisUsageRemaining
            ? "分析の利用枠がありません。"
            : !selectedOwnedChannel
              ? "所有チャンネルを選択してください。"
              : "選択した所有チャンネルだけを分析します。"}
      </p>

      {channelsError && <StatusPanel tone="error" title={channelsError} />}
      {usageError && <StatusPanel tone="error" title={usageError} />}
      {error && <StatusPanel tone="error" title={error} />}
      {consultError && <StatusPanel tone="error" title={consultError} />}
      {loading && (
        <StatusPanel tone="loading" title="チャンネルを分析しています">
          通常動画とショートの取得、集計、履歴保存を行っています。このままお待ちください。
        </StatusPanel>
      )}
      {consultLoading && (
        <StatusPanel tone="loading" title="AI提案を作成しています">
          現在の分析データをもとに改善候補を整理しています。
        </StatusPanel>
      )}
      {!channelTitle && !loading && !error && !channelsError && (
        <StatusPanel tone="info" title="所有チャンネルを確認してください">
          所有チャンネルを選び「分析する」を選ぶと、現状と根拠データを確認できます。
        </StatusPanel>
      )}

      {channelTitle && <AnalysisFlowGuide hasRecommendation={consult !== null} />}

      {channelTitle && (
        <>
          <div
            id="analysis-overview"
            className="youtube-grid-two analysis-section-anchor"
            style={styles.grid2}
          >
            <div style={styles.cardRed}>
              <p style={styles.smallLabel}>Overview</p>
              <h2
                style={{
                  marginTop: "8px",
                  marginBottom: "12px",
                  fontSize: "32px",
                  lineHeight: 1.08,
                  fontWeight: 900,
                  letterSpacing: "-0.04em",
                }}
              >
                {channelTitle}
              </h2>
              <p style={styles.prose}>
                通常動画は {regularVideos.length} 本、ショート動画は{" "}
                {shortVideos.length} 本を対象に整理しています。
                ランキング、分布、月別推移、改善候補までまとめて見られる状態です。
              </p>
            </div>

            <div style={styles.cardBlack}>
              <p
                style={{
                  ...styles.smallLabel,
                  color: "#ffb7c5",
                }}
              >
                Executive Summary
              </p>
              <div style={{ marginTop: "10px" }}>
                <p style={styles.darkProse}>
                  通常動画の平均再生は{" "}
                  <strong>
                    {regularAnalysis
                      ? `${regularAnalysis.averageViews.toLocaleString()} 回`
                      : "データなし"}
                  </strong>
                  です。
                </p>
                <p style={{ ...styles.darkProse, marginTop: "10px" }}>
                  ショート動画の平均再生は{" "}
                  <strong>
                    {shortAnalysis
                      ? `${shortAnalysis.averageViews.toLocaleString()} 回`
                      : "データなし"}
                  </strong>
                  です。
                </p>
                <p style={{ ...styles.darkProse, marginTop: "10px" }}>
                  投稿の間隔は、通常動画が{" "}
                  <strong>{regularAnalysis?.postingFrequency ?? "判定不可"}</strong>、
                  ショートが{" "}
                  <strong>{shortAnalysis?.postingFrequency ?? "判定不可"}</strong>
                  です。
                </p>
              </div>
            </div>
          </div>

          <div
            id="analysis-evidence"
            className="youtube-grid-three analysis-section-anchor"
            style={styles.grid3}
          >
            <div style={styles.statCard}>
              <p style={styles.smallLabel}>Regular Average</p>
              <h3 style={{ margin: "8px 0 0", fontSize: "30px", lineHeight: 1 }}>
                {regularAnalysis
                  ? regularAnalysis.averageViews.toLocaleString()
                  : "-"}
              </h3>
              <p style={{ margin: "10px 0 0", color: "#6b7280", fontSize: "13px" }}>
                {describePostingFrequency(regularAnalysis?.postingFrequency ?? "判定不可")}
              </p>
            </div>

            <div style={styles.statCard}>
              <p style={styles.smallLabel}>Short Average</p>
              <h3 style={{ margin: "8px 0 0", fontSize: "30px", lineHeight: 1 }}>
                {shortAnalysis ? shortAnalysis.averageViews.toLocaleString() : "-"}
              </h3>
              <p style={{ margin: "10px 0 0", color: "#6b7280", fontSize: "13px" }}>
                {describePostingFrequency(shortAnalysis?.postingFrequency ?? "判定不可")}
              </p>
            </div>

            <div style={styles.statCard}>
              <p style={styles.smallLabel}>Analyzed Videos</p>
              <h3 style={{ margin: "8px 0 0", fontSize: "30px", lineHeight: 1 }}>
                {regularVideos.length + shortVideos.length}
              </h3>
              <p style={{ margin: "10px 0 0", color: "#6b7280", fontSize: "13px" }}>
                通常動画とショート動画を合わせた分析対象本数です。
              </p>
            </div>
          </div>

          {consult && (
            <section
              id="analysis-priority"
              className="analysis-recommendation analysis-section-anchor"
              aria-label="AIによる改善提案"
            >
              <SectionIntro
                eyebrow="AI recommendation"
                title="分析から見えた改善候補"
                description="結論、強み・弱み、今すぐ見直すこと、次に試すことを、既存のAI提案データのまま整理しています。"
              />
              <div style={styles.section}>
                <p style={styles.smallLabel}>Diagnosis</p>
                <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                  提案の結論
                </h2>
                <p style={styles.prose}>{consult.overallDiagnosis}</p>
              </div>

              <div className="youtube-grid-two" style={styles.grid2}>
                <div style={styles.section}>
                  <p style={styles.smallLabel}>Strengths</p>
                  <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                    強み
                  </h2>
                  <ul style={styles.list}>
                    {consult.strongPoints.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div style={styles.section}>
                  <p style={styles.smallLabel}>Weaknesses</p>
                  <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                    弱み
                  </h2>
                  <ul style={styles.list}>
                    {consult.weakPoints.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="youtube-grid-two" style={styles.grid2}>
                <div style={styles.section}>
                  <p style={styles.smallLabel}>Current Fixes</p>
                  <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                    今すぐ見直すこと
                  </h2>
                  <ul style={styles.list}>
                    {consult.currentImprovements.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div style={styles.section}>
                  <p style={styles.smallLabel}>Next Direction</p>
                  <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                    次に試すこと
                  </h2>
                  <ul style={styles.list}>
                    {consult.nextSuggestions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      <WeeklyImprovementCycle
        currentAnalysisRunId={analysisResult?.analysisRunId ?? null}
        suggestedAction={
          consult?.currentImprovements[0] ?? consult?.nextSuggestions[0] ?? ""
        }
        refreshKey={historyRefreshKey}
      />

      {channelTitle && (
        <>
          <div
            id="analysis-metrics"
            className="youtube-grid-two analysis-section-anchor"
            style={styles.grid2}
          >
            <div style={styles.section}>
              <p style={styles.smallLabel}>Regular View Distribution</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                通常動画の再生分布
              </h2>
              <DonutChart
                title="通常動画"
                items={[
                  { label: "高い", value: regularBands[0].value, color: "#111111" },
                  { label: "中間", value: regularBands[1].value, color: "#8f8f8f" },
                  { label: "低い", value: regularBands[2].value, color: "#d90429" },
                ]}
              />
            </div>

            <div style={styles.section}>
              <p style={styles.smallLabel}>Short View Distribution</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                ショートの再生分布
              </h2>
              <DonutChart
                title="ショート"
                items={[
                  { label: "高い", value: shortBands[0].value, color: "#111111" },
                  { label: "中間", value: shortBands[1].value, color: "#8f8f8f" },
                  { label: "低い", value: shortBands[2].value, color: "#d90429" },
                ]}
              />
            </div>
          </div>

          <div className="youtube-grid-two" style={styles.grid2}>
            <div style={styles.section}>
              <p style={styles.smallLabel}>Regular Monthly Trend</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                通常動画の月別推移
              </h2>
              {regularBuckets.length > 0 ? (
                regularBuckets.map((bucket) => (
                  <div key={bucket.label} style={{ marginBottom: "14px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "10px",
                        fontSize: "13px",
                        fontWeight: 700,
                      }}
                    >
                      <span>{bucket.label}</span>
                      <span>{bucket.value.toLocaleString()} 回</span>
                    </div>
                    <div style={styles.barTrack}>
                      <div
                        style={{
                          ...styles.barFillBlack,
                          width: getSimpleBarWidth(bucket.value, regularBucketMax),
                        }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <StatusPanel tone="empty" title="通常動画の月別データがありません">
                  取得できた通常動画が少ない場合は、月別推移を表示できません。
                </StatusPanel>
              )}
            </div>

            <div style={styles.section}>
              <p style={styles.smallLabel}>Short Monthly Trend</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                ショートの月別推移
              </h2>
              {shortBuckets.length > 0 ? (
                shortBuckets.map((bucket) => (
                  <div key={bucket.label} style={{ marginBottom: "14px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "10px",
                        fontSize: "13px",
                        fontWeight: 700,
                      }}
                    >
                      <span>{bucket.label}</span>
                      <span>{bucket.value.toLocaleString()} 回</span>
                    </div>
                    <div style={styles.barTrack}>
                      <div
                        style={{
                          ...styles.barFillRed,
                          width: getSimpleBarWidth(bucket.value, shortBucketMax),
                        }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <StatusPanel tone="empty" title="ショートの月別データがありません">
                  取得できたショートが少ない場合は、月別推移を表示できません。
                </StatusPanel>
              )}
            </div>
          </div>

          <div className="youtube-grid-two" style={styles.grid2}>
            <div style={styles.section}>
              <p style={styles.smallLabel}>Regular Ranking</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                通常動画ランキング TOP10
              </h2>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>順位</th>
                      <th style={styles.th}>タイトル</th>
                      <th style={styles.th}>再生回数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regularTop10.map((video, index) => (
                      <tr key={video.id}>
                        <td style={styles.td}>{index + 1}</td>
                        <td style={styles.td}>{video.title}</td>
                        <td style={styles.td}>
                          {video.viewCountNumber.toLocaleString()} 回
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={styles.section}>
              <p style={styles.smallLabel}>Short Ranking</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                ショートランキング TOP10
              </h2>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>順位</th>
                      <th style={styles.th}>タイトル</th>
                      <th style={styles.th}>再生回数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortTop10.map((video, index) => (
                      <tr key={video.id}>
                        <td style={styles.td}>{index + 1}</td>
                        <td style={styles.td}>{video.title}</td>
                        <td style={styles.td}>
                          {video.viewCountNumber.toLocaleString()} 回
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="youtube-grid-two" style={styles.grid2}>
            <div style={styles.section}>
              <p style={styles.smallLabel}>Regular Weak Videos</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                通常動画の見直し候補
              </h2>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>順位</th>
                      <th style={styles.th}>タイトル</th>
                      <th style={styles.th}>再生回数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regularLow5.map((video, index) => (
                      <tr key={video.id}>
                        <td style={styles.td}>{index + 1}</td>
                        <td style={styles.td}>{video.title}</td>
                        <td style={styles.td}>
                          {video.viewCountNumber.toLocaleString()} 回
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={styles.section}>
              <p style={styles.smallLabel}>Short Weak Videos</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                ショートの見直し候補
              </h2>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>順位</th>
                      <th style={styles.th}>タイトル</th>
                      <th style={styles.th}>再生回数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortLow5.map((video, index) => (
                      <tr key={video.id}>
                        <td style={styles.td}>{index + 1}</td>
                        <td style={styles.td}>{video.title}</td>
                        <td style={styles.td}>
                          {video.viewCountNumber.toLocaleString()} 回
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="youtube-grid-two" style={styles.grid2}>
            <div style={styles.section}>
              <p style={styles.smallLabel}>Regular Details</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                通常動画の指標
              </h2>
              <ul style={styles.list}>
                <li>
                  平均再生回数:{" "}
                  {regularAnalysis
                    ? `${regularAnalysis.averageViews.toLocaleString()} 回`
                    : "データなし"}
                </li>
                <li>
                  中央値:{" "}
                  {regularAnalysis
                    ? `${regularAnalysis.medianViews.toLocaleString()} 回`
                    : "データなし"}
                </li>
                <li>
                  合計再生:{" "}
                  {regularAnalysis
                    ? `${regularAnalysis.totalViews.toLocaleString()} 回`
                    : "データなし"}
                </li>
                <li>
                  最も伸びた動画:{" "}
                  {regularAnalysis?.topVideo?.title ?? "データなし"}
                </li>
                <li>
                  最も弱い動画:{" "}
                  {regularAnalysis?.lowVideo?.title ?? "データなし"}
                </li>
              </ul>
            </div>

            <div style={styles.section}>
              <p style={styles.smallLabel}>Short Details</p>
              <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                ショートの指標
              </h2>
              <ul style={styles.list}>
                <li>
                  平均再生回数:{" "}
                  {shortAnalysis
                    ? `${shortAnalysis.averageViews.toLocaleString()} 回`
                    : "データなし"}
                </li>
                <li>
                  中央値:{" "}
                  {shortAnalysis
                    ? `${shortAnalysis.medianViews.toLocaleString()} 回`
                    : "データなし"}
                </li>
                <li>
                  合計再生:{" "}
                  {shortAnalysis
                    ? `${shortAnalysis.totalViews.toLocaleString()} 回`
                    : "データなし"}
                </li>
                <li>
                  最も伸びた動画: {shortAnalysis?.topVideo?.title ?? "データなし"}
                </li>
                <li>
                  最も弱い動画: {shortAnalysis?.lowVideo?.title ?? "データなし"}
                </li>
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
