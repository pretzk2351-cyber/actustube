"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  getSafeClientApiErrorFeedback,
  parseOwnedChannelsResponse,
  parseUsageStatusResponse,
  type ClientUsageStatus,
  type OwnedChannelOption,
} from "@/app/lib/youtube-form-flow";
import type {
  AnalysisHistoryItem,
  ImprovementActionView,
  WeeklyCycleHistoryResponse,
} from "@/app/lib/weekly-cycle-types";

export type WorkspaceVideo = {
  id: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: string;
  duration?: string;
  durationSeconds?: number;
  isShort?: boolean;
};

export type WorkspaceAnalysisResult = {
  analysisRunId: string;
  channelId: string;
  channelTitle: string;
  regularVideos: WorkspaceVideo[];
  shortVideos: WorkspaceVideo[];
};

export type WorkspaceConsultResult = {
  overallDiagnosis: string;
  strongPoints: string[];
  weakPoints: string[];
  currentImprovements: string[];
  nextSuggestions: string[];
};

export type WorkspaceUser = {
  name: string;
  email: string;
  image: string | null;
};

type ReadOnlyResponse = {
  ok: boolean;
  status: number;
  data: unknown;
};

const readOnlyRequests = new Map<string, Promise<ReadOnlyResponse>>();

function fetchReadOnlyJson(url: string) {
  const existing = readOnlyRequests.get(url);
  if (existing) return existing;

  const request = fetch(url, { cache: "no-store" })
    .then(async (response) => ({
      ok: response.ok,
      status: response.status,
      data: (await response.json().catch(() => null)) as unknown,
    }))
    .finally(() => {
      readOnlyRequests.delete(url);
    });
  readOnlyRequests.set(url, request);
  return request;
}

function isImprovementAction(value: unknown): value is ImprovementActionView {
  if (typeof value !== "object" || value === null) return false;
  const action = value as Partial<ImprovementActionView>;
  return (
    typeof action.id === "string" &&
    typeof action.analysisRunId === "string" &&
    typeof action.title === "string" &&
    typeof action.description === "string" &&
    ["planned", "completed", "skipped"].includes(String(action.status)) &&
    (action.resultNote === null || typeof action.resultNote === "string") &&
    typeof action.createdAt === "string" &&
    typeof action.updatedAt === "string" &&
    (action.completedAt === null || typeof action.completedAt === "string")
  );
}

function isHistoryItem(value: unknown): value is AnalysisHistoryItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AnalysisHistoryItem>;
  return (
    typeof item.id === "string" &&
    typeof item.channelId === "string" &&
    typeof item.channelTitle === "string" &&
    typeof item.analyzedAt === "string" &&
    !Number.isNaN(Date.parse(item.analyzedAt)) &&
    Number.isSafeInteger(item.regularVideoCount) &&
    (item.regularVideoCount as number) >= 0 &&
    Number.isSafeInteger(item.shortVideoCount) &&
    (item.shortVideoCount as number) >= 0 &&
    typeof item.regularAverageViews === "number" &&
    Number.isFinite(item.regularAverageViews) &&
    typeof item.shortAverageViews === "number" &&
    Number.isFinite(item.shortAverageViews) &&
    typeof item.hasAIConsult === "boolean" &&
    (item.aiConsultCreatedAt === null ||
      typeof item.aiConsultCreatedAt === "string") &&
    (item.action === null || isImprovementAction(item.action))
  );
}

function parseHistoryResponse(value: unknown): WeeklyCycleHistoryResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<WeeklyCycleHistoryResponse>;
  if (
    !Array.isArray(candidate.items) ||
    !candidate.items.every(isHistoryItem) ||
    !(typeof candidate.nextCursor === "string" || candidate.nextCursor === null) ||
    !(candidate.plannedAction === null ||
      isImprovementAction(candidate.plannedAction))
  ) {
    return null;
  }
  return candidate as WeeklyCycleHistoryResponse;
}

type AppWorkspaceValue = {
  user: WorkspaceUser;
  usageStatus: ClientUsageStatus | null;
  usageLoading: boolean;
  usageError: string;
  refreshUsage: () => Promise<ClientUsageStatus | null>;
  ownedChannels: OwnedChannelOption[];
  channelsLoading: boolean;
  channelsError: string;
  refreshOwnedChannels: () => Promise<OwnedChannelOption[] | null>;
  selectedOwnedChannelId: string;
  setSelectedOwnedChannelId: (channelId: string) => void;
  history: WeeklyCycleHistoryResponse | null;
  historyLoading: boolean;
  historyError: string;
  historyLoadingMore: boolean;
  refreshHistory: () => Promise<WeeklyCycleHistoryResponse | null>;
  loadMoreHistory: () => Promise<boolean>;
  replaceHistory: (history: WeeklyCycleHistoryResponse) => void;
  analysisResult: WorkspaceAnalysisResult | null;
  setAnalysisResult: (result: WorkspaceAnalysisResult | null) => void;
  consultResult: WorkspaceConsultResult | null;
  setConsultResult: (result: WorkspaceConsultResult | null) => void;
  activeWriteAction: "analysis" | "consult" | null;
  beginWriteAction: (action: "analysis" | "consult") => boolean;
  endWriteAction: (action: "analysis" | "consult") => void;
};

const AppWorkspaceContext = createContext<AppWorkspaceValue | null>(null);

export function AppWorkspaceProvider({
  user,
  children,
}: {
  user: WorkspaceUser;
  children: ReactNode;
}) {
  const [usageStatus, setUsageStatus] = useState<ClientUsageStatus | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState("");
  const [ownedChannels, setOwnedChannels] = useState<OwnedChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState("");
  const [selectedOwnedChannelId, setSelectedOwnedChannelId] = useState("");
  const [history, setHistory] = useState<WeeklyCycleHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [analysisResult, setAnalysisResult] =
    useState<WorkspaceAnalysisResult | null>(null);
  const [consultResult, setConsultResult] =
    useState<WorkspaceConsultResult | null>(null);
  const activeWriteActionRef = useRef<"analysis" | "consult" | null>(null);
  const [activeWriteAction, setActiveWriteAction] = useState<
    "analysis" | "consult" | null
  >(null);

  const beginWriteAction = useCallback((action: "analysis" | "consult") => {
    if (activeWriteActionRef.current !== null) return false;
    activeWriteActionRef.current = action;
    setActiveWriteAction(action);
    return true;
  }, []);

  const endWriteAction = useCallback((action: "analysis" | "consult") => {
    if (activeWriteActionRef.current !== action) return;
    activeWriteActionRef.current = null;
    setActiveWriteAction(null);
  }, []);

  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError("");
    try {
      const response = await fetchReadOnlyJson("/api/usage/status");
      const parsed = response.ok ? parseUsageStatusResponse(response.data) : null;
      if (!parsed) {
        setUsageStatus(null);
        setUsageError(
          getSafeClientApiErrorFeedback(
            response.status,
            response.data,
            "usage_status"
          ).message
        );
        return null;
      }
      setUsageStatus(parsed);
      return parsed;
    } catch {
      setUsageStatus(null);
      setUsageError(
        "利用枠を確認できませんでした。安全のため分析とAI提案を停止しています。"
      );
      return null;
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const refreshOwnedChannels = useCallback(async () => {
    setChannelsLoading(true);
    setChannelsError("");
    try {
      const response = await fetchReadOnlyJson("/api/youtube/my-channels");
      const parsed = response.ok
        ? parseOwnedChannelsResponse(response.data)
        : null;
      if (!parsed) {
        setOwnedChannels([]);
        setSelectedOwnedChannelId("");
        setChannelsError(
          getSafeClientApiErrorFeedback(
            response.status,
            response.data,
            "owned_channels"
          ).message
        );
        return null;
      }
      setOwnedChannels(parsed);
      setSelectedOwnedChannelId((current) =>
        parsed.some((channel) => channel.id === current)
          ? current
          : parsed.length === 1
            ? parsed[0].id
            : ""
      );
      return parsed;
    } catch {
      setOwnedChannels([]);
      setSelectedOwnedChannelId("");
      setChannelsError(
        "所有チャンネルを取得できませんでした。任意入力では分析できません。"
      );
      return null;
    } finally {
      setChannelsLoading(false);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetchReadOnlyJson("/api/weekly-cycle?limit=10");
      const parsed = response.ok ? parseHistoryResponse(response.data) : null;
      if (!parsed) {
        setHistory(null);
        setHistoryError(
          response.status === 401
            ? "再ログインしてください。"
            : "分析と改善の履歴を読み込めませんでした。"
        );
        return null;
      }
      setHistory(parsed);
      return parsed;
    } catch {
      setHistory(null);
      setHistoryError("分析と改善の履歴を読み込めませんでした。");
      return null;
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadMoreHistory = useCallback(async () => {
    if (!history?.nextCursor || historyLoadingMore) return false;
    setHistoryLoadingMore(true);
    setHistoryError("");
    try {
      const response = await fetchReadOnlyJson(
        `/api/weekly-cycle?limit=10&cursor=${encodeURIComponent(history.nextCursor)}`
      );
      const parsed = response.ok ? parseHistoryResponse(response.data) : null;
      if (!parsed) {
        setHistoryError("続きの履歴を読み込めませんでした。");
        return false;
      }
      setHistory((current) => {
        if (!current) return parsed;
        const known = new Set(current.items.map((item) => item.id));
        return {
          ...parsed,
          plannedAction: parsed.plannedAction ?? current.plannedAction,
          items: [
            ...current.items,
            ...parsed.items.filter((item) => !known.has(item.id)),
          ],
        };
      });
      return true;
    } catch {
      setHistoryError("続きの履歴を読み込めませんでした。");
      return false;
    } finally {
      setHistoryLoadingMore(false);
    }
  }, [history, historyLoadingMore]);

  const replaceHistory = useCallback((nextHistory: WeeklyCycleHistoryResponse) => {
    setHistory(nextHistory);
    setHistoryError("");
  }, []);

  useEffect(() => {
    void refreshUsage();
    void refreshOwnedChannels();
    void refreshHistory();
  }, [refreshHistory, refreshOwnedChannels, refreshUsage]);

  const value = useMemo<AppWorkspaceValue>(
    () => ({
      user,
      usageStatus,
      usageLoading,
      usageError,
      refreshUsage,
      ownedChannels,
      channelsLoading,
      channelsError,
      refreshOwnedChannels,
      selectedOwnedChannelId,
      setSelectedOwnedChannelId,
      history,
      historyLoading,
      historyError,
      historyLoadingMore,
      refreshHistory,
      loadMoreHistory,
      replaceHistory,
      analysisResult,
      setAnalysisResult,
      consultResult,
      setConsultResult,
      activeWriteAction,
      beginWriteAction,
      endWriteAction,
    }),
    [
      analysisResult,
      activeWriteAction,
      beginWriteAction,
      channelsError,
      channelsLoading,
      consultResult,
      endWriteAction,
      history,
      historyError,
      historyLoading,
      historyLoadingMore,
      loadMoreHistory,
      ownedChannels,
      refreshHistory,
      refreshOwnedChannels,
      replaceHistory,
      refreshUsage,
      selectedOwnedChannelId,
      usageError,
      usageLoading,
      usageStatus,
      user,
    ]
  );

  return (
    <AppWorkspaceContext.Provider value={value}>
      {children}
    </AppWorkspaceContext.Provider>
  );
}

export function useAppWorkspace() {
  const value = useContext(AppWorkspaceContext);
  if (!value) {
    throw new Error("AppWorkspaceProvider is required.");
  }
  return value;
}
