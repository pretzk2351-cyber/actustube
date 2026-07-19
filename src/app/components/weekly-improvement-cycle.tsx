"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  AnalysisHistoryItem,
  ImprovementActionView,
  WeeklyCycleHistoryResponse,
} from "@/app/lib/weekly-cycle-types";

type Props = {
  currentAnalysisRunId: string | null;
  suggestedAction: string;
  refreshKey: number;
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
  section: {
    backgroundColor: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "24px",
    padding: "24px",
    marginBottom: "22px",
    boxShadow: "0 14px 30px rgba(0,0,0,0.05)",
  } as const,
  input: {
    width: "100%",
    boxSizing: "border-box" as const,
    border: "1px solid #d1d5db",
    borderRadius: "12px",
    padding: "11px 12px",
    fontSize: "14px",
    marginTop: "6px",
  } as const,
  button: {
    border: 0,
    borderRadius: "12px",
    padding: "11px 15px",
    fontWeight: 800,
    cursor: "pointer",
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
}: Props) {
  const [items, setItems] = useState<AnalysisHistoryItem[]>([]);
  const [plannedAction, setPlannedAction] =
    useState<ImprovementActionView | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [resultNote, setResultNote] = useState("");

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/weekly-cycle?limit=10", {
        cache: "no-store",
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok || !isHistoryResponse(data)) {
        setMessage(safeMessage(response.status));
        return;
      }
      setItems(data.items);
      setPlannedAction(data.plannedAction);
      setNextCursor(data.nextCursor);
    } catch {
      setMessage("週次改善サイクルを読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage, refreshKey]);

  useEffect(() => {
    if (!plannedAction) return;
    setEditTitle(plannedAction.title);
    setEditDescription(plannedAction.description);
    setResultNote("");
  }, [plannedAction]);

  useEffect(() => {
    if (!currentAnalysisRunId || plannedAction) return;
    setNewTitle(suggestedAction.slice(0, 200));
    setNewDescription(
      suggestedAction
        ? "次の動画で実行し、完了後に結果を記録します。"
        : ""
    );
  }, [currentAnalysisRunId, plannedAction, suggestedAction]);

  async function createAction() {
    if (!currentAnalysisRunId) return;
    setSaving(true);
    setMessage("");
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
        setMessage(safeMessage(response.status));
        return;
      }
      await loadFirstPage();
      setMessage("今週の改善項目を保存しました。");
    } catch {
      setMessage("改善項目を保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function updateAction(status?: "completed" | "skipped") {
    if (!plannedAction) return;
    setSaving(true);
    setMessage("");
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
        setMessage(safeMessage(response.status));
        return;
      }
      await loadFirstPage();
      setMessage(status ? "改善結果を保存しました。" : "改善項目を更新しました。");
    } catch {
      setMessage("改善項目を更新できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/weekly-cycle?limit=10&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store" }
      );
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok || !isHistoryResponse(data)) {
        setMessage(safeMessage(response.status));
        return;
      }
      setItems((current) => [...current, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch {
      setMessage("履歴の続きを読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={ui.section} aria-labelledby="weekly-cycle-title">
      <p style={{ margin: 0, color: "#d90429", fontSize: "12px", fontWeight: 900 }}>
        WEEKLY IMPROVEMENT CYCLE
      </p>
      <h2 id="weekly-cycle-title" style={{ margin: "8px 0 6px", fontSize: "26px" }}>
        今週の改善サイクル
      </h2>
      <p style={{ margin: "0 0 20px", color: "#6b7280", lineHeight: 1.7 }}>
        分析結果から実行項目を1件決め、実行後に結果を記録します。
      </p>

      {message && (
        <div style={{ padding: "11px 13px", marginBottom: "16px", borderRadius: "12px", background: "#fff1f2", color: "#9f1239", fontWeight: 700 }}>
          {message}
        </div>
      )}

      {plannedAction ? (
        <div style={{ padding: "18px", border: "1px solid #fecdd3", borderRadius: "18px", background: "#fff7f8", marginBottom: "24px" }}>
          <strong>進行中の改善項目</strong>
          <label style={{ ...ui.label, marginTop: "14px" }}>
            タイトル
            <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={200} style={ui.input} disabled={saving} />
          </label>
          <label style={ui.label}>
            説明
            <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} maxLength={2000} rows={3} style={ui.input} disabled={saving} />
          </label>
          <label style={ui.label}>
            実行後の結果メモ
            <textarea value={resultNote} onChange={(event) => setResultNote(event.target.value)} maxLength={2000} rows={3} style={ui.input} disabled={saving} placeholder="実行して分かったことや次回直す点" />
          </label>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button type="button" onClick={() => void updateAction()} disabled={saving || !editTitle.trim()} style={{ ...ui.button, background: "#111827", color: "#fff" }}>内容を保存</button>
            <button type="button" onClick={() => void updateAction("completed")} disabled={saving || !editTitle.trim() || !resultNote.trim()} style={{ ...ui.button, background: "#d90429", color: "#fff" }}>完了にする</button>
            <button type="button" onClick={() => void updateAction("skipped")} disabled={saving || !editTitle.trim() || !resultNote.trim()} style={{ ...ui.button, background: "#e5e7eb", color: "#111827" }}>見送る</button>
          </div>
        </div>
      ) : currentAnalysisRunId ? (
        <div style={{ padding: "18px", border: "1px solid #e5e7eb", borderRadius: "18px", marginBottom: "24px" }}>
          <strong>この分析から今週の改善項目を設定</strong>
          <label style={{ ...ui.label, marginTop: "14px" }}>
            タイトル
            <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={200} style={ui.input} disabled={saving} />
          </label>
          <label style={ui.label}>
            説明
            <textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} maxLength={2000} rows={3} style={ui.input} disabled={saving} />
          </label>
          <button type="button" onClick={() => void createAction()} disabled={saving || !newTitle.trim()} style={{ ...ui.button, background: "#d90429", color: "#fff" }}>
            {saving ? "保存中..." : "今週の改善項目として保存"}
          </button>
        </div>
      ) : (
        <p style={{ padding: "15px", borderRadius: "14px", background: "#f3f4f6", color: "#4b5563", fontWeight: 700 }}>
          チャンネル分析後に、今週の改善項目を設定できます。
        </p>
      )}

      <h3 style={{ margin: "24px 0 12px", fontSize: "20px" }}>過去の分析と改善項目</h3>
      {!loading && items.length === 0 ? (
        <p style={{ color: "#6b7280" }}>保存された分析履歴はまだありません。</p>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {items.map((item) => (
            <article key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: "16px", padding: "15px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                <strong>{item.channelTitle}</strong>
                <span style={{ color: "#6b7280", fontSize: "13px" }}>{formatDate(item.analyzedAt)}</span>
              </div>
              <p style={{ margin: "10px 0", color: "#4b5563", fontSize: "14px" }}>
                通常 {item.regularVideoCount}本・平均 {item.regularAverageViews.toLocaleString()}回 ／ Shorts {item.shortVideoCount}本・平均 {item.shortAverageViews.toLocaleString()}回 ／ AI提案 {item.hasAIConsult ? "あり" : "なし"}
              </p>
              {item.action ? (
                <div style={{ padding: "10px 12px", borderRadius: "12px", background: "#f9fafb" }}>
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
        <button type="button" onClick={() => void loadMore()} disabled={loading} style={{ ...ui.button, marginTop: "14px", background: "#e5e7eb", color: "#111827" }}>
          {loading ? "読み込み中..." : "さらに表示"}
        </button>
      )}
    </section>
  );
}
