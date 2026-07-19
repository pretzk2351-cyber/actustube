export const IMPROVEMENT_ACTION_STATUSES = [
  "planned",
  "completed",
  "skipped",
] as const;

export type ImprovementActionStatus =
  (typeof IMPROVEMENT_ACTION_STATUSES)[number];

export type AnalysisSnapshotVideo = {
  id?: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: string;
  duration?: string;
  durationSeconds?: number;
  isShort?: boolean;
};

export type ChannelAnalysisSnapshot = {
  plan: string;
  channelId: string;
  channelTitle: string;
  channelDescription: string;
  subscriberCount: string;
  videoCount: string;
  viewCount: string;
  regularVideos: AnalysisSnapshotVideo[];
  shortVideos: AnalysisSnapshotVideo[];
};

export type AIConsultSnapshot = {
  overallDiagnosis: string;
  strongPoints: string[];
  weakPoints: string[];
  currentImprovements: string[];
  nextSuggestions: string[];
};

export type ImprovementActionView = {
  id: string;
  analysisRunId: string;
  title: string;
  description: string;
  status: ImprovementActionStatus;
  resultNote: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AnalysisHistoryItem = {
  id: string;
  channelId: string;
  channelTitle: string;
  analyzedAt: string;
  regularVideoCount: number;
  shortVideoCount: number;
  regularAverageViews: number;
  shortAverageViews: number;
  hasAIConsult: boolean;
  aiConsultCreatedAt: string | null;
  action: ImprovementActionView | null;
};

export type WeeklyCycleHistoryResponse = {
  items: AnalysisHistoryItem[];
  plannedAction: ImprovementActionView | null;
  nextCursor: string | null;
};
