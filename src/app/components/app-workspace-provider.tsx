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
  canRequestAIConsult,
  evaluateChannelAnalysisResponse,
  getSafeClientApiErrorFeedback,
  getSafeClientNetworkErrorFeedback,
  hasUsageRemaining,
  parseOwnedChannelsResponse,
  parseUsageStatusResponse,
  type ClientUsageStatus,
  type ClientErrorFeedback,
  type OwnedChannelOption,
} from "@/app/lib/youtube-form-flow";
import type {
  AnalysisHistoryItem,
  ImprovementActionView,
  WeeklyCycleHistoryResponse,
} from "@/app/lib/weekly-cycle-types";
import { buildWorkspaceAISummary } from "@/app/lib/analysis-summary";

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

type WriteAction = "analysis" | "consult";
type WriteToken = { action: WriteAction };
type OperationState = {
  status: "idle" | "requesting" | "applying" | "success" | "error" | "empty";
  error: ClientErrorFeedback | null;
  emptyChannel: string | null;
  refreshError: string;
};
const idleOperation: OperationState = { status: "idle", error: null, emptyChannel: null, refreshError: "" };

function isConsultResult(value: unknown): value is WorkspaceConsultResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceConsultResult>;
  return typeof candidate.overallDiagnosis === "string" && [candidate.strongPoints, candidate.weakPoints, candidate.currentImprovements, candidate.nextSuggestions].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
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
  refreshHistory: (fresh?: boolean) => Promise<WeeklyCycleHistoryResponse | null>;
  loadMoreHistory: () => Promise<boolean>;
  beginHistoryUpdate: () => (history: WeeklyCycleHistoryResponse | null) => boolean;
  captureHistoryRead: () => () => boolean;
  analysisResult: WorkspaceAnalysisResult | null;
  setAnalysisResult: (result: WorkspaceAnalysisResult | null) => void;
  consultResult: WorkspaceConsultResult | null;
  setConsultResult: (result: WorkspaceConsultResult | null) => void;
  activeWriteAction: "analysis" | "consult" | null;
  analysisOperation: OperationState;
  consultOperation: OperationState;
  analyze: () => Promise<void>;
  consult: () => Promise<void>;
};

const AppWorkspaceContext = createContext<AppWorkspaceValue | null>(null);

export function AppWorkspaceProvider({
  user,
  children,
}: {
  user: WorkspaceUser;
  children: ReactNode;
}) {
  // Session changes get a new cache, operation ownership and result lifetime.
  return <WorkspaceState key={user.email} user={user}>{children}</WorkspaceState>;
}

function WorkspaceState({ user, children }: { user: WorkspaceUser; children: ReactNode }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const readOnlyRequests = useRef(new Map<string, Promise<ReadOnlyResponse>>());
  const fetchReadOnlyJson = useCallback((url: string, fresh = false) => {
    const requests = readOnlyRequests.current;
    const existing = requests.get(url);
    if (!fresh && existing) return existing;
    const request = fetch(url, { cache: "no-store" })
      .then(async (response): Promise<ReadOnlyResponse> => ({
        ok: response.ok, status: response.status,
        data: await response.json().catch(() => null),
      }))
      .finally(() => {
        if (requests.get(url) === request) requests.delete(url);
      });
    requests.set(url, request);
    return request;
  }, []);
  const historyGeneration = useRef(0);
  const historyRequest = useRef<Promise<ReadOnlyResponse> | null>(null);
  const usageGeneration = useRef(0);
  const historyMoreRequest = useRef<object | null>(null);
  const [usageStatus, setUsageStatus] = useState<ClientUsageStatus | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState("");
  const [ownedChannels, setOwnedChannels] = useState<OwnedChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState("");
  const [selectedOwnedChannelId, setSelectedChannel] = useState("");
  const [history, setHistory] = useState<WeeklyCycleHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [analysisResult, setAnalysisResult] =
    useState<WorkspaceAnalysisResult | null>(null);
  const [consultResult, setConsultResult] =
    useState<WorkspaceConsultResult | null>(null);
  const [analysisOperation, setAnalysisOperation] = useState(idleOperation);
  const [consultOperation, setConsultOperation] = useState(idleOperation);
  const activeWriteActionRef = useRef<WriteToken | null>(null);
  const [activeWriteAction, setActiveWriteAction] = useState<
    "analysis" | "consult" | null
  >(null);

  const beginWriteAction = useCallback((action: WriteAction) => {
    if (!mounted.current || activeWriteActionRef.current !== null) return null;
    const token = { action };
    activeWriteActionRef.current = token;
    setActiveWriteAction(action);
    return token;
  }, []);

  const isCurrentWrite = useCallback((token: WriteToken) => mounted.current && activeWriteActionRef.current === token, []);
  const endWriteAction = useCallback((token: WriteToken) => {
    if (!isCurrentWrite(token)) return;
    activeWriteActionRef.current = null;
    setActiveWriteAction(null);
  }, [isCurrentWrite]);

  const setSelectedOwnedChannelId = useCallback((channelId: string) => {
    if (activeWriteActionRef.current || channelId === selectedOwnedChannelId) return;
    if (channelId && !ownedChannels.some((channel) => channel.id === channelId)) return;
    setSelectedChannel(channelId);
    setAnalysisResult(null);
    setConsultResult(null);
    setAnalysisOperation(idleOperation);
    setConsultOperation(idleOperation);
  }, [ownedChannels, selectedOwnedChannelId]);

  const refreshUsage = useCallback(async (fresh = false) => {
    const generation = ++usageGeneration.current;
    const current = () => mounted.current && generation === usageGeneration.current;
    setUsageLoading(true);
    setUsageError("");
    try {
      const response = await fetchReadOnlyJson("/api/usage/status", fresh);
      if (!current()) return null;
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
      if (!current()) return null;
      setUsageStatus(null);
      setUsageError(
        "利用枠を確認できませんでした。安全のため分析とAI提案を停止しています。"
      );
      return null;
    } finally {
      if (current()) setUsageLoading(false);
    }
  }, [fetchReadOnlyJson]);

  const refreshOwnedChannels = useCallback(async () => {
    setChannelsLoading(true);
    setChannelsError("");
    try {
      const response = await fetchReadOnlyJson("/api/youtube/my-channels");
      if (!mounted.current) return null;
      const parsed = response.ok
        ? parseOwnedChannelsResponse(response.data)
        : null;
      if (!parsed) {
        setOwnedChannels([]);
        setSelectedChannel("");
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
      setSelectedChannel((current) =>
        parsed.some((channel) => channel.id === current)
          ? current
          : parsed.length === 1
            ? parsed[0].id
            : ""
      );
      return parsed;
    } catch {
      if (!mounted.current) return null;
      setOwnedChannels([]);
      setSelectedChannel("");
      setChannelsError(
        "所有チャンネルを取得できませんでした。任意入力では分析できません。"
      );
      return null;
    } finally {
      if (mounted.current) setChannelsLoading(false);
    }
  }, [fetchReadOnlyJson]);

  const refreshHistory = useCallback(async (fresh = false) => {
    const url = "/api/weekly-cycle?limit=10";
    const existing = fresh ? undefined : readOnlyRequests.current.get(url);
    // Callers joining the same fresh snapshot share its generation too.
    const generation = existing && existing === historyRequest.current
      ? historyGeneration.current : ++historyGeneration.current;
    const current = () => mounted.current && generation === historyGeneration.current;
    historyMoreRequest.current = null;
    setHistoryLoadingMore(false);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const request = fetchReadOnlyJson(url, fresh);
      historyRequest.current = request;
      const response = await request;
      const parsed = response.ok ? parseHistoryResponse(response.data) : null;
      // A superseded successful GET still succeeded for its write caller. It
      // must not apply state, or turn that saved operation into a refresh error.
      if (!current()) return parsed;
      if (!parsed) {
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
      if (!current()) return null;
      setHistoryError("分析と改善の履歴を読み込めませんでした。");
      return null;
    } finally {
      if (current()) setHistoryLoading(false);
    }
  }, [fetchReadOnlyJson]);

  const loadMoreHistory = useCallback(async () => {
    if (!history?.nextCursor || historyMoreRequest.current || historyLoading) return false;
    const request = {};
    historyMoreRequest.current = request;
    const generation = historyGeneration.current;
    const current = () => mounted.current && generation === historyGeneration.current && historyMoreRequest.current === request;
    setHistoryLoadingMore(true);
    setHistoryError("");
    try {
      const response = await fetchReadOnlyJson(
        `/api/weekly-cycle?limit=10&cursor=${encodeURIComponent(history.nextCursor)}`,
        true
      );
      if (!current()) return false;
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
      if (!current()) return false;
      setHistoryError("続きの履歴を読み込めませんでした。");
      return false;
    } finally {
      if (current()) {
        historyMoreRequest.current = null;
        setHistoryLoadingMore(false);
      }
    }
  }, [fetchReadOnlyJson, history, historyLoading]);

  const captureHistoryRead = useCallback(() => {
    const generation = historyGeneration.current;
    return () => mounted.current && generation === historyGeneration.current;
  }, []);

  const beginHistoryUpdate = useCallback(() => {
    // Called immediately before the improvement component starts its GET,
    // never when that GET completes. The returned closure owns only this read.
    const generation = ++historyGeneration.current;
    historyRequest.current = null;
    readOnlyRequests.current.delete("/api/weekly-cycle?limit=10");
    historyMoreRequest.current = null;
    setHistoryLoading(true);
    setHistoryLoadingMore(false);
    setHistoryError("");
    let settled = false;
    return (nextHistory: WeeklyCycleHistoryResponse | null) => {
      if (settled || !mounted.current || generation !== historyGeneration.current) return false;
      settled = true;
      const parsed = parseHistoryResponse(nextHistory);
      if (parsed) setHistory(parsed);
      setHistoryError(parsed ? "" : "分析と改善の履歴を読み込めませんでした。");
      setHistoryLoading(false);
      return parsed !== null;
    };
  }, []);

  const analyze = useCallback(async () => {
    if (!usageStatus || usageLoading || !hasUsageRemaining(usageStatus.usage.channelAnalysis) ||
        !ownedChannels.some((channel) => channel.id === selectedOwnedChannelId)) return;
    const token = beginWriteAction("analysis");
    if (!token) return;
    setAnalysisOperation({ ...idleOperation, status: "requesting" });
    setConsultOperation(idleOperation);
    setAnalysisResult(null);
    setConsultResult(null);
    try {
      const response = await fetch(`/api/youtube/channel?channelId=${encodeURIComponent(selectedOwnedChannelId)}`);
      const data: unknown = await response.json().catch(() => null);
      if (!isCurrentWrite(token)) return;
      const decision = evaluateChannelAnalysisResponse(response.status, data);
      if (!decision.accepted) {
        setAnalysisOperation(decision.kind === "empty"
          ? { ...idleOperation, status: "empty", emptyChannel: decision.empty.channelTitle.trim() }
          : { ...idleOperation, status: "error", error: decision.feedback });
        if (decision.kind === "empty" || decision.feedback.requiresUsageRefresh) await refreshUsage(true);
        return;
      }
      setAnalysisResult({ analysisRunId: decision.analysis.analysisRunId, channelId: decision.analysis.channelId, channelTitle: decision.analysis.channelTitle.trim(), regularVideos: (decision.analysis.regularVideos ?? []) as WorkspaceVideo[], shortVideos: (decision.analysis.shortVideos ?? []) as WorkspaceVideo[] });
      setAnalysisOperation({ ...idleOperation, status: "applying" });
      const [updatedUsage, updatedHistory] = await Promise.all([refreshUsage(true), refreshHistory(true)]);
      if (!isCurrentWrite(token)) return;
      setAnalysisOperation({ ...idleOperation, status: "success", refreshError: !updatedUsage || !updatedHistory
        ? "分析は保存されましたが、利用枠または履歴の表示を更新できませんでした。再分析せず、画面を再読み込みして確認してください。" : "" });
    } catch (caught) {
      if (!isCurrentWrite(token)) return;
      const refreshed = await refreshUsage(true);
      if (!isCurrentWrite(token)) return;
      setAnalysisOperation({ ...idleOperation, status: "error", error: getSafeClientNetworkErrorFeedback(
        caught instanceof DOMException && (caught.name === "AbortError" || caught.name === "TimeoutError") ? "timeout" : "network", refreshed !== null) });
    } finally {
      endWriteAction(token);
    }
  }, [beginWriteAction, endWriteAction, isCurrentWrite, ownedChannels, refreshHistory, refreshUsage, selectedOwnedChannelId, usageLoading, usageStatus]);

  const consult = useCallback(async () => {
    if (!analysisResult || !usageStatus || usageLoading || !hasUsageRemaining(usageStatus.usage.aiConsult)) return;
    const summary = buildWorkspaceAISummary(analysisResult);
    if (!canRequestAIConsult(summary)) return;
    const token = beginWriteAction("consult");
    if (!token) return;
    setConsultOperation({ ...idleOperation, status: "requesting" });
    setConsultResult(null);
    try {
      const response = await fetch("/api/ai-consult", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiSummary: summary, analysisRunId: analysisResult.analysisRunId }) });
      const data: unknown = await response.json().catch(() => null);
      if (!isCurrentWrite(token)) return;
      if (!response.ok || !isConsultResult(data)) {
        const feedback = getSafeClientApiErrorFeedback(response.status, data, "ai_consult");
        setConsultOperation({ ...idleOperation, status: "error", error: feedback });
        if (feedback.requiresUsageRefresh) await refreshUsage(true);
        return;
      }
      setConsultResult(data);
      setConsultOperation({ ...idleOperation, status: "applying" });
      const [updatedUsage, updatedHistory] = await Promise.all([refreshUsage(true), refreshHistory(true)]);
      if (!isCurrentWrite(token)) return;
      setConsultOperation({ ...idleOperation, status: "success", refreshError: !updatedUsage || !updatedHistory
        ? "AI提案は保存されましたが、利用枠または履歴の表示を更新できませんでした。再実行せず、画面を再読み込みして確認してください。" : "" });
    } catch (caught) {
      if (!isCurrentWrite(token)) return;
      const refreshed = await refreshUsage(true);
      if (!isCurrentWrite(token)) return;
      setConsultOperation({ ...idleOperation, status: "error", error: getSafeClientNetworkErrorFeedback(
        caught instanceof DOMException && (caught.name === "AbortError" || caught.name === "TimeoutError") ? "timeout" : "network", refreshed !== null) });
    } finally {
      endWriteAction(token);
    }
  }, [analysisResult, beginWriteAction, endWriteAction, isCurrentWrite, refreshHistory, refreshUsage, usageLoading, usageStatus]);

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
      beginHistoryUpdate,
      captureHistoryRead,
      analysisResult,
      setAnalysisResult,
      consultResult,
      setConsultResult,
      activeWriteAction,
      analysisOperation,
      consultOperation,
      analyze,
      consult,
    }),
    [
      analysisResult,
      activeWriteAction,
      analysisOperation,
      consultOperation,
      analyze,
      consult,
      channelsError,
      channelsLoading,
      consultResult,
      history,
      historyError,
      historyLoading,
      historyLoadingMore,
      loadMoreHistory,
      ownedChannels,
      refreshHistory,
      refreshOwnedChannels,
      beginHistoryUpdate,
      captureHistoryRead,
      refreshUsage,
      selectedOwnedChannelId,
      setSelectedOwnedChannelId,
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
