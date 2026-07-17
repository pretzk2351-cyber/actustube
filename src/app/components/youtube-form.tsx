"use client";

import { useMemo, useState } from "react";

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

type ChannelApiResponse = {
  error?: string;
  channelTitle: string;
  regularVideos?: Video[];
  shortVideos?: Video[];
};

type AIConsultApiResponse = AIConsultResult & {
  error?: string;
};

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

      <div>
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
    maxWidth: "1320px",
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
    flex: 1,
    minWidth: "320px",
    border: "1px solid #dddddd",
    borderRadius: "18px",
    overflow: "hidden",
    backgroundColor: "#ffffff",
    boxShadow: "0 10px 24px rgba(0,0,0,0.04)",
  } as const,
  prefix: {
    padding: "15px 14px 15px 16px",
    backgroundColor: "#fafafa",
    color: "#6b7280",
    fontSize: "14px",
    fontWeight: 700,
    borderRight: "1px solid #ededed",
    whiteSpace: "nowrap" as const,
  } as const,
  input: {
    flex: 1,
    minWidth: "180px",
    padding: "15px 16px",
    border: "none",
    backgroundColor: "#ffffff",
    color: "#111111",
    fontSize: "15px",
    outline: "none",
  } as const,
  button: {
    padding: "15px 20px",
    borderRadius: "16px",
    border: "1px solid #d90429",
    backgroundColor: "#d90429",
    color: "#ffffff",
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 12px 26px rgba(217,4,41,0.18)",
  } as const,
  consultButton: {
    padding: "15px 20px",
    borderRadius: "16px",
    border: "1px solid #111111",
    backgroundColor: "#111111",
    color: "#ffffff",
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 12px 26px rgba(0,0,0,0.14)",
  } as const,
  section: {
    backgroundColor: "#ffffff",
    border: "1px solid #ebebeb",
    borderRadius: "24px",
    padding: "24px",
    marginBottom: "22px",
    boxShadow: "0 14px 30px rgba(0,0,0,0.05)",
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
    gridTemplateColumns: "1fr 1fr",
    gap: "22px",
    marginBottom: "22px",
  } as const,
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "18px",
    marginBottom: "22px",
  } as const,
  statCard: {
    border: "1px solid #ededed",
    borderRadius: "20px",
    padding: "20px",
    background:
      "linear-gradient(180deg, rgba(255,255,255,1) 0%, rgba(249,250,251,1) 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6)",
  } as const,
  cardRed: {
    background:
      "linear-gradient(135deg, rgba(217,4,41,0.08) 0%, rgba(255,255,255,1) 65%)",
    border: "1px solid #ffd4dc",
    borderRadius: "24px",
    padding: "24px",
    boxShadow: "0 16px 34px rgba(217,4,41,0.08)",
  } as const,
  cardBlack: {
    background:
      "linear-gradient(135deg, #111111 0%, #171717 55%, #202020 100%)",
    color: "#ffffff",
    borderRadius: "24px",
    padding: "24px",
    boxShadow: "0 18px 38px rgba(0,0,0,0.16)",
  } as const,
  list: {
    margin: 0,
    paddingLeft: "20px",
    lineHeight: 1.95,
  } as const,
  errorBox: {
    marginBottom: "20px",
    padding: "13px 15px",
    borderRadius: "14px",
    backgroundColor: "#fff1f2",
    color: "#b91c1c",
    border: "1px solid #fecdd3",
    fontWeight: 700,
  } as const,
  smallLabel: {
    margin: 0,
    fontSize: "12px",
    fontWeight: 800,
    letterSpacing: "0.05em",
    color: "#d90429",
    textTransform: "uppercase" as const,
  } as const,
  prose: {
    margin: 0,
    lineHeight: 1.95,
    color: "#232323",
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
    border: "1px solid #ededed",
    borderRadius: "18px",
  } as const,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    minWidth: "760px",
    backgroundColor: "#ffffff",
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
    background:
      "linear-gradient(90deg, #111111 0%, #2a2a2a 100%)",
    borderRadius: "999px",
  } as const,
  barFillRed: {
    height: "100%",
    background:
      "linear-gradient(90deg, #d90429 0%, #ff3358 100%)",
    borderRadius: "999px",
  } as const,
};

export function YouTubeForm() {
  const [channelInput, setChannelInput] = useState("@");
  const [loading, setLoading] = useState(false);
  const [channelTitle, setChannelTitle] = useState("");
  const [regularVideos, setRegularVideos] = useState<Video[]>([]);
  const [shortVideos, setShortVideos] = useState<Video[]>([]);
  const [error, setError] = useState("");
  const [consultLoading, setConsultLoading] = useState(false);
  const [consultError, setConsultError] = useState("");
  const [consult, setConsult] = useState<AIConsultResult | null>(null);

  const hasActiveSubscription = true;
  const currentPlan = hasActiveSubscription ? "standard" : "free";

  const fullUrl = `https://www.youtube.com/${channelInput.replace(/^\/+/, "")}`;

  const handleFetch = async () => {
    setLoading(true);
    setError("");
    setChannelTitle("");
    setRegularVideos([]);
    setShortVideos([]);
    setConsult(null);
    setConsultError("");

    try {
      const res = await fetch(
        `/api/youtube/channel?url=${encodeURIComponent(fullUrl)}&plan=${currentPlan}`
      );

      const text = await res.text();

      let data: ChannelApiResponse;
      try {
        data = JSON.parse(text) as ChannelApiResponse;
      } catch {
        throw new Error(`YouTube APIの応答がJSONではありません。status=${res.status}`);
      }

      if (!res.ok) {
        throw new Error(data.error || "取得に失敗しました");
      }

      setChannelTitle(data.channelTitle);
      setRegularVideos(data.regularVideos ?? []);
      setShortVideos(data.shortVideos ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const regularAnalysis = getAnalysis(regularVideos);
  const shortAnalysis = getAnalysis(shortVideos);

  const consultPayload = useMemo(
    () =>
      buildAISummary(
        channelTitle,
        regularVideos,
        shortVideos,
        regularAnalysis,
        shortAnalysis
      ),
    [channelTitle, regularVideos, shortVideos, regularAnalysis, shortAnalysis]
  );

  const handleConsult = async () => {
    if (!consultPayload) {
      setConsultError("分析データがありません");
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
        body: JSON.stringify({ aiSummary: consultPayload }),
      });

      const text = await res.text();

      let data: AIConsultApiResponse;
      try {
        data = JSON.parse(text) as AIConsultApiResponse;
      } catch {
        throw new Error(`コンサル生成の応答がJSONではありません。status=${res.status}`);
      }

      if (!res.ok) {
        throw new Error(data.error || "コンサル生成に失敗しました");
      }

      setConsult(data);
    } catch (err) {
      setConsultError(
        err instanceof Error ? err.message : "コンサル生成エラーが発生しました"
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

  return (
    <div style={styles.page}>
      <div style={styles.inputBar}>
        <div style={styles.prefixWrap}>
          <div style={styles.prefix}>https://www.youtube.com/</div>
          <input
            type="text"
            value={channelInput}
            onChange={(e) => setChannelInput(e.target.value)}
            placeholder="@チャンネル名"
            style={styles.input}
          />
        </div>

        <button onClick={handleFetch} style={styles.button}>
          {loading ? "分析中..." : "分析する"}
        </button>

        {consultPayload && (
          <button onClick={handleConsult} style={styles.consultButton}>
            {consultLoading ? "提案を整理中..." : "提案を見る"}
          </button>
        )}
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}
      {consultError && <div style={styles.errorBox}>{consultError}</div>}

      {channelTitle && (
        <>
          <div style={styles.grid2}>
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

          <div style={styles.grid3}>
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
            <>
              <div style={styles.section}>
                <p style={styles.smallLabel}>Diagnosis</p>
                <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                  全体の見立て
                </h2>
                <p style={styles.prose}>{consult.overallDiagnosis}</p>
              </div>

              <div style={styles.grid2}>
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

              <div style={styles.grid2}>
                <div style={styles.section}>
                  <p style={styles.smallLabel}>Current Fixes</p>
                  <h2 style={{ ...styles.sectionTitle, marginTop: "8px" }}>
                    今の改善点
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
                    次回以降の提案
                  </h2>
                  <ul style={styles.list}>
                    {consult.nextSuggestions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}

          <div style={styles.grid2}>
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

          <div style={styles.grid2}>
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
                <p style={styles.prose}>データがありません。</p>
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
                <p style={styles.prose}>データがありません。</p>
              )}
            </div>
          </div>

          <div style={styles.grid2}>
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

          <div style={styles.grid2}>
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

          <div style={styles.grid2}>
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
