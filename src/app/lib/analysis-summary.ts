import type { WorkspaceAnalysisResult, WorkspaceVideo } from "@/app/components/app-workspace-provider";

function numberOfViews(video: WorkspaceVideo) {
  const value = Number(video.viewCount);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function summarize(videos: WorkspaceVideo[]) {
  const sorted = [...videos].sort((a, b) => numberOfViews(b) - numberOfViews(a));
  const total = videos.reduce((sum, video) => sum + numberOfViews(video), 0);
  const byDate = [...videos].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
  );
  let postingFrequency = "判定不可";
  if (byDate.length > 1) {
    const differences = byDate.slice(0, -1).map((video, index) =>
      Math.abs(Date.parse(video.publishedAt) - Date.parse(byDate[index + 1].publishedAt)) /
      (1000 * 60 * 60 * 24)
    );
    const averageDays = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    postingFrequency = averageDays <= 3 ? "かなり高い" : averageDays <= 7 ? "高め" : averageDays <= 14 ? "普通" : "低め";
  }
  return {
    count: videos.length,
    averageViews: videos.length ? Math.round(total / videos.length) : 0,
    postingFrequency,
    topVideo: sorted[0] ? { title: sorted[0].title, views: numberOfViews(sorted[0]) } : null,
    lowVideo: sorted.at(-1) ? { title: sorted.at(-1)!.title, views: numberOfViews(sorted.at(-1)!) } : null,
    videos: videos.map((video) => ({
      title: video.title,
      views: numberOfViews(video),
      publishedAt: video.publishedAt,
    })),
  };
}

export function buildWorkspaceAISummary(result: WorkspaceAnalysisResult) {
  return {
    channelTitle: result.channelTitle,
    regular: summarize(result.regularVideos),
    shorts: summarize(result.shortVideos),
  };
}

export function averageViews(videos: WorkspaceVideo[]) {
  if (!videos.length) return 0;
  return Math.round(videos.reduce((sum, video) => sum + numberOfViews(video), 0) / videos.length);
}
