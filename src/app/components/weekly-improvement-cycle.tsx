"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SectionIntro, StatusPanel } from "@/app/components/ui-foundation";
import type {
  AnalysisHistoryItem,
  ImprovementActionView,
  WeeklyCycleHistoryResponse,
} from "@/app/lib/weekly-cycle-types";
import {
  currentAnalysisHasAction,
  refreshHistoryForDuplicateAction,
  shouldShowImprovementActionCreateForm,
} from "@/app/lib/weekly-cycle-flow";
import {
  createWeeklyCycleNotice,
  type WeeklyCycleNotice,
} from "@/app/lib/weekly-cycle-notice";

type Props = {
  currentAnalysisRunId: string | null;
  suggestedAction: string;
  refreshKey: number;
  onHistoryCountChange?: (count: number | null) => void;
  initialHistory?: WeeklyCycleHistoryResponse | null;
  onHistoryChange?: (history: WeeklyCycleHistoryResponse) => void;
  onHistoryRequestStart?: () => (history: WeeklyCycleHistoryResponse | null) => boolean;
  onHistoryReadStart?: () => () => boolean;
  historyRefreshing?: boolean;
};

const statusLabels = {
  planned: "予定",
  completed: "完了",
  skipped: "見送り",
} as const;

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function safeMessage(status: number) {
  if (status === 401) return "再ログインしてください。";
  if (status === 404) return "対象の分析履歴が見つかりません。";
  if (status === 409) return "進行中の改善項目は1件までです。";
  if (status === 400) return "入力内容を確認してください。";
  return "週次改善サイクルの更新に失敗しました。";
}

function isHistoryResponse(value: unknown): value is WeeklyCycleHistoryResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as WeeklyCycleHistoryResponse).items) &&
    (typeof (value as WeeklyCycleHistoryResponse).nextCursor === "string" ||
      (value as WeeklyCycleHistoryResponse).nextCursor === null)
  );
}

const ui = {
  input: {
    width: "100%",
    boxSizing: "border-box" as const,
    border: "1px solid var(--color-border-strong)",
    borderRadius: "12px",
    padding: "11px 12px",
    fontSize: "14px",
    marginTop: "6px",
  } as const,
  button: {
    borderRadius: "12px",
  } as const,
  label: {
    display: "block",
    fontSize: "13px",
    fontWeight: 800,
    color: "#374151",
    marginBottom: "14px",
  } as const,
};

export function WeeklyImprovementCycle({
  currentAnalysisRunId,
  suggestedAction,
  refreshKey,
  onHistoryCountChange,
  initialHistory,
  onHistoryChange,
  onHistoryRequestStart,
  onHistoryReadStart,
  historyRefreshing = false,
}: Props) {
  const [items, setItems] = useState<AnalysisHistoryItem[]>([]);
  const [plannedAction, setPlannedAction] =
    useState<ImprovementActionView | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [localLoading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<WeeklyCycleNotice>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [resultNote, setResultNote] = useState("");
  const initialHistoryApplied = useRef(false);
  const initialHistoryRef = useRef(initialHistory);
  const localHistoryGeneration = useRef(0);
  const localHistoryCurrent = useRef<() => boolean>(() => true);
  const loading = historyRefreshing || (localLoading && localHistoryCurrent.current());
  const hasActionForCurrentAnalysis = currentAnalysisHasAction(
    items,
    currentAnalysisRunId
  );
  const showCreateActionForm = shouldShowImprovementActionCreateForm({
    currentAnalysisRunId,
    items,
    plannedAction,
    loading,
  });

  const loadFirstPage = useCallback(async (): Promise<boolean | "superseded"> => {
    const generation = ++localHistoryGeneration.current;
    setLoading(true);
    setNotice(null);
    // Capture request ownership before fetch; a completion must never acquire
    // a newer generation just because the component navigated away meanwhile.
    const completeHistoryRequest = onHistoryRequestStart?.();
    const sharedReadCurrent = onHistoryReadStart?.();
    const current = () => generation === localHistoryGeneration.current && (!sharedReadCurrent || sharedReadCurrent());
    localHistoryCurrent.current = current;
    try {
      const response = await fetch("/api/weekly-cycle?limit=10", {
        cache: "no-store",
      });
      const data: unknown = await response.json().catch(() => null);
      if (!current()) return "superseded";
      if (!response.ok || !isHistoryResponse(data)) {
        completeHistoryRequest?.(null);
        onHistoryCountChange?.(null);
        setNotice(createWeeklyCycleNotice("error", safeMessage(response.status)));
        return false;
      }
      if (completeHistoryRequest && !completeHistoryRequest(data)) return false;
      setItems(data.items);
      onHistoryCountChange?.(data.items.length);
      setPlannedAction(data.plannedAction);
      setNextCursor(data.nextCursor);
      onHistoryChange?.(data);
      return true;
    } catch {
      if (!current()) return "superseded";
      completeHistoryRequest?.(null);
      onHistoryCountChange?.(null);
      setNotice(
        createWeeklyCycleNotice(
          "error",
          "週次改善サイクルを読み込めませんでした。"
        )
      );
      return false;
    } finally {
      if (current()) setLoading(false);
    }
  }, [onHistoryChange, onHistoryCountChange, onHistoryRequestStart, onHistoryReadStart]);

  useEffect(() => {
    // A save started by a previous mount can finish after this view remounts.
    // Consume that accepted Provider snapshot without issuing another GET.
    if (!initialHistory || initialHistory === initialHistoryRef.current) return;
    initialHistoryRef.current = initialHistory;
    ++localHistoryGeneration.current;
    setItems(initialHistory.items);
    setPlannedAction(initialHistory.plannedAction);
    setNextCursor(initialHistory.nextCursor);
    setLoading(false);
  }, [initialHistory]);

  useEffect(() => {
    const seededHistory = initialHistoryRef.current;
    if (seededHistory) {
      if (!initialHistoryApplied.current) {
        initialHistoryApplied.current = true;
        setItems(seededHistory.items);
        setPlannedAction(seededHistory.plannedAction);
        setNextCursor(seededHistory.nextCursor);
        setLoading(false);
        onHistoryCountChange?.(seededHistory.items.length);
      }
      return;
    }
    void loadFirstPage();
  }, [loadFirstPage, onHistoryCountChange, refreshKey]);

  useEffect(() => {
    if (!plannedAction) return;
    setEditTitle(plannedAction.title);
    setEditDescription(plannedAction.description);
    setResultNote("");
  }, [plannedAction]);

  useEffect(() => {
    if (!currentAnalysisRunId || plannedAction || hasActionForCurrentAnalysis) return;
    setNewTitle(suggestedAction.slice(0, 200));
    setNewDescription(
      suggestedAction
        ? "次の動画で実行し、完了後に結果を記録します。"
        : ""
    );
  }, [
    currentAnalysisRunId,
    hasActionForCurrentAnalysis,
    plannedAction,
    suggestedAction,
  ]);

  async function createAction() {
    if (!currentAnalysisRunId) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/weekly-cycle/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisRunId: currentAnalysisRunId,
          title: newTitle,
          description: newDescription,
        }),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        if (
          await refreshHistoryForDuplicateAction(
            response.status,
            data,
            async () => {
              await loadFirstPage();
            }
          )
        ) {
          return;
        }
        setNotice(createWeeklyCycleNotice("error", safeMessage(response.status)));
        return;
      }
      const refreshed = await loadFirstPage();
      if (refreshed === "superseded") return;
      if (!refreshed) {
        setNotice(
          createWeeklyCycleNotice(
            "error",
            "改善項目は作成されましたが、最新の履歴を読み込めませんでした。ページを再読み込みして確認してください。"
          )
        );
        return;
      }
      setNotice(
        createWeeklyCycleNotice("success", "今週の改善項目を保存しました。")
      );
    } catch {
      setNotice(
        createWeeklyCycleNotice("error", "改善項目を保存できませんでした。")
      );
    } finally {
      setSaving(false);
    }
  }

  async function updateAction(status?: "completed" | "skipped") {
    if (!plannedAction) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/weekly-cycle/actions/${plannedAction.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: editTitle,
            description: editDescription,
            ...(status ? { status, resultNote } : {}),
          }),
        }
      );
      if (!response.ok) {
        setNotice(createWeeklyCycleNotice("error", safeMessage(response.status)));
        return;
      }
      const refreshed = await loadFirstPage();
      if (refreshed === "superseded") return;
      if (!refreshed) {
        setNotice(
          createWeeklyCycleNotice(
            "error",
            "変更は保存されましたが、最新の履歴を読み込めませんでした。ページを再読み込みして確認してください。"
          )
        );
        return;
      }
      setNotice(
        createWeeklyCycleNotice(
          "success",
          status ? "改善結果を保存しました。" : "改善項目を更新しました。"
        )
      );
    } catch {
      setNotice(
        createWeeklyCycleNotice("error", "改善項目を更新できませんでした。")
      );
    } finally {
      setSaving(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    const generation = ++localHistoryGeneration.current;
    const sharedReadCurrent = onHistoryReadStart?.();
    const current = () => generation === localHistoryGeneration.current && (!sharedReadCurrent || sharedReadCurrent());
    localHistoryCurrent.current = current;
    setLoading(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/weekly-cycle?limit=10&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store" }
      );
      const data: unknown = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok || !isHistoryResponse(data)) {
        setNotice(createWeeklyCycleNotice("error", safeMessage(response.status)));
        return;
      }
      setItems((current) => [...current, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch {
      if (!current()) return;
      setNotice(
        createWeeklyCycleNotice("error", "履歴の続きを読み込めませんでした。")
      );
    } finally {
      if (current()) setLoading(false);
    }
  }

  return (
    <section className="surface-card weekly-cycle" aria-labelledby="weekly-cycle-title">
      <SectionIntro
        id="weekly-cycle-title"
        eyebrow="Weekly improvement cycle"
        title="今週の改善サイクル"
        description="分析結果から実行項目を1件決め、実行後に結果を記録します。"
      />

      {notice && <StatusPanel tone={notice.tone} title={notice.message} />}

      {loading && items.length === 0 ? (
        <StatusPanel tone="loading" title="改善履歴を読み込んでいます">
          分析履歴と進行中の改善項目を確認しています。
        </StatusPanel>
      ) : plannedAction ? (
        <div className="weekly-cycle__active">
          <strong>進行中の改善項目</strong>
          <label style={{ ...ui.label, marginTop: "14px" }}>
            タイトル
            <input className="form-control" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={200} style={ui.input} disabled={saving} />
          </label>
          <label style={ui.label}>
            説明
            <textarea className="form-control" value={editDescription} onChange={(event) => setEditDescription(event.target.value)} maxLength={2000} rows={3} style={ui.input} disabled={saving} />
          </label>
          <label style={ui.label}>
            実行後の結果メモ
            <textarea className="form-control" value={resultNote} onChange={(event) => setResultNote(event.target.value)} maxLength={2000} rows={3} style={ui.input} disabled={saving} placeholder="実行して分かったことや次回直す点" />
          </label>
          <div className="form-actions">
            <button className="button button--dark" type="button" onClick={() => void updateAction()} disabled={saving || !editTitle.trim()} style={ui.button}>内容を保存</button>
            <button className="button button--primary" type="button" onClick={() => void updateAction("completed")} disabled={saving || !editTitle.trim() || !resultNote.trim()} style={ui.button}>完了にする</button>
            <button className="button button--secondary" type="button" onClick={() => void updateAction("skipped")} disabled={saving || !editTitle.trim() || !resultNote.trim()} style={ui.button}>見送る</button>
          </div>
        </div>
      ) : showCreateActionForm ? (
        <div className="weekly-cycle__create">
          <strong>この分析から今週の改善項目を設定</strong>
          <label style={{ ...ui.label, marginTop: "14px" }}>
            タイトル
            <input className="form-control" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={200} style={ui.input} disabled={saving} />
          </label>
          <label style={ui.label}>
            説明
            <textarea className="form-control" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} maxLength={2000} rows={3} style={ui.input} disabled={saving} />
          </label>
          <button className="button button--primary" type="button" onClick={() => void createAction()} disabled={saving || !newTitle.trim()} style={ui.button}>
            {saving ? "保存中..." : "今週の改善項目として保存"}
          </button>
        </div>
      ) : hasActionForCurrentAnalysis ? (
        <StatusPanel tone="success" title="この分析には改善項目が保存されています">
          内容と実行結果は、下の履歴で確認できます。
        </StatusPanel>
      ) : (
        <StatusPanel tone="empty" title="今週の改善項目はまだありません">
          チャンネル分析後に、実行する改善項目を1件設定できます。
        </StatusPanel>
      )}

      <h3 style={{ margin: "24px 0 12px", fontSize: "20px" }}>過去の分析と改善項目</h3>
      {!loading && items.length === 0 ? (
        <StatusPanel tone="empty" title="保存された分析履歴はまだありません">
          最初のチャンネル分析が完了すると、ここに履歴が表示されます。
        </StatusPanel>
      ) : (
        <div className="weekly-cycle__history">
          {items.map((item) => (
            <article className="weekly-cycle__history-card" key={item.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                <strong>{item.channelTitle}</strong>
                <span style={{ color: "#6b7280", fontSize: "13px" }}>{formatDate(item.analyzedAt)}</span>
              </div>
              <p className="weekly-cycle__history-summary" style={{ margin: "10px 0" }}>
                通常 {item.regularVideoCount}本・平均 {item.regularAverageViews.toLocaleString()}回 ／ Shorts {item.shortVideoCount}本・平均 {item.shortAverageViews.toLocaleString()}回 ／ AI提案 {item.hasAIConsult ? "あり" : "なし"}
              </p>
              {item.action ? (
                <div className="weekly-cycle__action-summary">
                  <strong>{statusLabels[item.action.status]}：{item.action.title}</strong>
                  {item.action.description && <p style={{ margin: "6px 0 0", color: "#4b5563" }}>{item.action.description}</p>}
                  {item.action.resultNote && <p style={{ margin: "6px 0 0", color: "#4b5563" }}>結果：{item.action.resultNote}</p>}
                </div>
              ) : (
                <span style={{ color: "#9ca3af", fontSize: "13px" }}>改善項目なし</span>
              )}
            </article>
          ))}
        </div>
      )}
      {nextCursor && (
        <button className="button button--secondary" type="button" onClick={() => void loadMore()} disabled={loading} style={{ ...ui.button, marginTop: "14px" }}>
          {loading ? "読み込み中..." : "さらに表示"}
        </button>
      )}
    </section>
  );
}
