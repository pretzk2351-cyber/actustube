"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import {
  useAppWorkspace,
  type WorkspaceConsultResult,
  type WorkspaceVideo,
} from "@/app/components/app-workspace-provider";
import { BETA_ONBOARDING_DISMISSED_KEY, BetaOnboardingGuide } from "@/app/components/beta-onboarding-guide";
import { SignOutButton } from "@/app/components/auth-buttons";
import { StatusPanel } from "@/app/components/ui-foundation";
import { WeeklyImprovementCycle } from "@/app/components/weekly-improvement-cycle";
import { averageViews, buildWorkspaceAISummary } from "@/app/lib/analysis-summary";
import {
  canRequestAIConsult,
  evaluateChannelAnalysisResponse,
  getSafeClientApiErrorFeedback,
  getSafeClientNetworkErrorFeedback,
  hasUsageRemaining,
  type ClientErrorFeedback,
} from "@/app/lib/youtube-form-flow";

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <header className="workspace-page-header"><div><p>{eyebrow}</p><h1>{title}</h1><span>{description}</span></div>{action}</header>;
}

function EmptyState({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="workspace-empty"><span className="workspace-empty__mark" aria-hidden="true">○</span><h2>{title}</h2><div>{children}</div>{action && <div className="workspace-empty__action">{action}</div>}</div>;
}

function UsageMetric({ label, used, limit, remaining }: { label: string; used: number; limit: number; remaining: number }) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return <div className="usage-metric"><div className="usage-metric__heading"><strong>{label}</strong><span>{used} / {limit}</span></div><div className="usage-metric__track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div><p>残り {remaining} 回</p></div>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function DashboardView() {
  const { usageStatus, usageLoading, usageError, history, historyLoading, historyError, analysisResult, consultResult } = useAppWorkspace();
  const latest = history?.items[0] ?? null;
  const priorityAction = history?.plannedAction?.title ?? consultResult?.currentImprovements[0] ?? null;
  return <div className="workspace-page">
    <PageHeader eyebrow="OVERVIEW" title="ダッシュボード" description="現在の利用状況と、次に行うことを実データだけで確認できます。" action={<Link className="workspace-button workspace-button--primary" href="/app/analysis">動画を分析</Link>} />
    <BetaOnboardingGuide analysisHistoryCount={!historyLoading && !historyError ? history?.items.length ?? 0 : null} />
    <section className="workspace-grid workspace-grid--summary" aria-label="現在の状況">
      <article className="workspace-card workspace-card--wide"><div className="workspace-card__heading"><div><p className="workspace-card__eyebrow">USAGE</p><h2>今の利用枠</h2></div><Link href="/app/plan">詳細を見る</Link></div>{usageLoading ? <StatusPanel tone="loading" title="利用枠を確認しています" /> : usageError || !usageStatus ? <StatusPanel tone="error" title="利用枠を表示できません">{usageError}</StatusPanel> : <div className="usage-grid"><UsageMetric label="分析（日次）" {...usageStatus.usage.channelAnalysis.daily} /><UsageMetric label="AI提案（日次）" {...usageStatus.usage.aiConsult.daily} /></div>}</article>
      <article className="workspace-card"><p className="workspace-card__eyebrow">ACTIVE PLAN</p><h2>{usageStatus?.plan.code ?? "確認中"}</h2><p className="workspace-card__muted">現在の契約状態です。未提供プランの価格は表示しません。</p></article>
      <article className="workspace-card"><p className="workspace-card__eyebrow">CURRENT ACTION</p><h2>{priorityAction ?? "まず分析する"}</h2><p className="workspace-card__muted">{history?.plannedAction ? "plannedとして記録されています。" : priorityAction ? "今回生成したAI提案の先頭候補です。まだ改善項目には保存されていません。" : "推測で改善点を作らず、分析から始めます。"}</p><Link href={priorityAction ? "/app/improvements" : "/app/analysis"}>{priorityAction ? "改善サイクルへ" : "動画分析へ"}</Link></article>
    </section>
    <section className="workspace-grid workspace-grid--two">
      <article className="workspace-card"><div className="workspace-card__heading"><div><p className="workspace-card__eyebrow">LATEST ANALYSIS</p><h2>直近の分析</h2></div><Link href="/app/history">履歴を見る</Link></div>{historyLoading ? <StatusPanel tone="loading" title="履歴を確認しています" /> : historyError ? <StatusPanel tone="error" title="履歴を表示できません">{historyError}</StatusPanel> : latest ? <div className="workspace-latest"><strong>{latest.channelTitle}</strong><span>{formatDate(latest.analyzedAt)}</span><dl><div><dt>通常動画</dt><dd>{latest.regularVideoCount}本</dd></div><div><dt>Shorts</dt><dd>{latest.shortVideoCount}本</dd></div><div><dt>AI提案</dt><dd>{latest.hasAIConsult ? "あり" : "なし"}</dd></div></dl></div> : <EmptyState title="分析履歴はまだありません">最初の分析を行うと、ここに結果の要約が表示されます。</EmptyState>}</article>
      <article className="workspace-card"><p className="workspace-card__eyebrow">CURRENT SESSION</p><h2>今回の作業</h2>{analysisResult ? <div className="workspace-comparison"><div><span>強みの手がかり</span><strong>{consultResult?.strongPoints[0] ?? `取得動画 ${analysisResult.regularVideos.length + analysisResult.shortVideos.length}本`}</strong></div><div><span>次の改善候補</span><strong>{consultResult?.currentImprovements[0] ?? "AI提案を実行すると表示されます"}</strong></div></div> : <EmptyState title="今回の分析結果はありません">分析結果はこのログイン中の画面内だけで共有されます。<Link className="workspace-button workspace-button--secondary" href="/app/analysis">分析を始める</Link></EmptyState>}</article>
    </section>
  </div>;
}

export function AnalysisView() {
  const { usageStatus, usageLoading, usageError, ownedChannels, channelsLoading, channelsError, selectedOwnedChannelId, setSelectedOwnedChannelId, refreshUsage, refreshHistory, history, historyLoading, historyError, analysisResult, setAnalysisResult, setConsultResult, activeWriteAction, beginWriteAction, endWriteAction } = useAppWorkspace();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<"idle" | "requesting" | "applying" | "complete">("idle");
  const [emptyChannel, setEmptyChannel] = useState("");
  const [error, setError] = useState<ClientErrorFeedback | null>(null);
  const inFlight = useRef(false);
  const selected = ownedChannels.find((channel) => channel.id === selectedOwnedChannelId);
  const canAnalyze = Boolean(selected && usageStatus && hasUsageRemaining(usageStatus.usage.channelAnalysis) && !loading && activeWriteAction === null);

  async function analyze() {
    if (inFlight.current || !selectedOwnedChannelId || !usageStatus || !beginWriteAction("analysis")) return;
    inFlight.current = true;
    setLoading(true);
    setProgress("requesting");
    setError(null);
    setEmptyChannel("");
    setAnalysisResult(null);
    setConsultResult(null);
    try {
      const response = await fetch(`/api/youtube/channel?channelId=${encodeURIComponent(selectedOwnedChannelId)}`);
      const data: unknown = await response.json().catch(() => null);
      const decision = evaluateChannelAnalysisResponse(response.status, data);
      if (!decision.accepted) {
        if (decision.kind === "empty") setEmptyChannel(decision.empty.channelTitle.trim());
        else setError(decision.feedback);
        if (decision.kind === "empty" || decision.feedback.requiresUsageRefresh) await refreshUsage();
        setProgress("idle");
        return;
      }
      setProgress("applying");
      setAnalysisResult({ analysisRunId: decision.analysis.analysisRunId, channelId: decision.analysis.channelId, channelTitle: decision.analysis.channelTitle.trim(), regularVideos: (decision.analysis.regularVideos ?? []) as WorkspaceVideo[], shortVideos: (decision.analysis.shortVideos ?? []) as WorkspaceVideo[] });
      await Promise.all([refreshUsage(), refreshHistory()]);
      setProgress("complete");
    } catch (caught) {
      const refreshed = await refreshUsage();
      setError(getSafeClientNetworkErrorFeedback(caught instanceof DOMException && (caught.name === "AbortError" || caught.name === "TimeoutError") ? "timeout" : "network", refreshed !== null));
      setProgress("idle");
    } finally {
      inFlight.current = false;
      endWriteAction("analysis");
      setLoading(false);
    }
  }

  return <div className="workspace-page"><PageHeader eyebrow="ANALYZE" title="動画分析" description="所有チャンネルの通常動画とShortsを分けて取得し、実績を確認します。" />
    <BetaOnboardingGuide analysisHistoryCount={!historyLoading && !historyError ? history?.items.length ?? 0 : null} />
    {!analysisResult && !loading && !error && !emptyChannel && <StatusPanel tone="info" title="分析前です">所有チャンネルを確認し、「動画を分析」を押した後に動画取得が始まります。通常動画とShortsを分けて処理します。</StatusPanel>}
    <section className="workspace-card"><div className="workspace-form-row"><label htmlFor="owned-channel">所有チャンネル</label>{channelsLoading ? <span>確認中…</span> : channelsError ? <StatusPanel tone="error" title="チャンネルを取得できません">{channelsError}</StatusPanel> : ownedChannels.length === 0 ? <StatusPanel tone="empty" title="所有チャンネルが見つかりません" /> : <select id="owned-channel" value={selectedOwnedChannelId} disabled={loading || activeWriteAction !== null} onChange={(event) => { if (activeWriteAction !== null) return; setSelectedOwnedChannelId(event.target.value); setAnalysisResult(null); setConsultResult(null); setEmptyChannel(""); setError(null); setProgress("idle"); }}><option value="">選択してください</option>{ownedChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}</select>}</div>
      {usageLoading ? <StatusPanel tone="loading" title="利用枠を確認しています" /> : usageError ? <StatusPanel tone="error" title="利用枠を確認できません">{usageError}</StatusPanel> : usageStatus && <p className="workspace-inline-note">分析枠：本日残り {usageStatus.usage.channelAnalysis.daily.remaining} 回／今月残り {usageStatus.usage.channelAnalysis.monthly.remaining} 回<br />1回の処理上限：通常動画 {usageStatus.plan.regularVideoLimit}本／Shorts {usageStatus.plan.shortsVideoLimit}本</p>}
      <button type="button" className="workspace-button workspace-button--primary" disabled={!canAnalyze} aria-busy={loading} onClick={analyze}>{loading ? "分析しています…" : "動画を分析"}</button>
    </section>
    {loading && <StatusPanel tone="loading" title={progress === "applying" ? "結果を反映しています" : "動画の取得と分析を行っています"}>完了までこのページでお待ちください。割合は推測表示しません。</StatusPanel>}
    {error && <StatusPanel tone="error" title={error.title}>{error.message}</StatusPanel>}
    {emptyChannel && <StatusPanel tone="empty" title="分析できる動画がありません">{emptyChannel}には、現在取得できる通常動画またはShortsがありません。利用枠と履歴は消費されません。YouTubeへ動画を投稿し、YouTube側の処理完了後にもう一度分析してください。</StatusPanel>}
    {analysisResult && <AnalysisResults />}
  </div>;
}

function AnalysisResults() {
  const { analysisResult } = useAppWorkspace();
  if (!analysisResult) return null;
  const groups = [{ label: "通常動画", videos: analysisResult.regularVideos }, { label: "Shorts", videos: analysisResult.shortVideos }];
  return <section className="workspace-stack" aria-labelledby="analysis-result-title"><div className="workspace-card"><p className="workspace-card__eyebrow">RESULT</p><h2 id="analysis-result-title">{analysisResult.channelTitle}</h2><div className="workspace-result-metrics">{groups.map((group) => <div key={group.label}><span>{group.label}</span><strong>{group.videos.length}本</strong><small>平均再生 {averageViews(group.videos).toLocaleString("ja-JP")}回</small></div>)}</div><div className="workspace-next-actions"><Link className="workspace-button workspace-button--primary" href="/app/consult">AI提案を見る</Link><Link className="workspace-button workspace-button--secondary" href="/app/improvements">改善サイクルへ</Link></div></div>
    {groups.map((group) => <article className="workspace-card" key={group.label}><h2>{group.label}</h2>{group.videos.length ? <div className="workspace-video-list">{group.videos.map((video) => <div key={video.id}><strong>{video.title}</strong><span>{Number(video.viewCount).toLocaleString("ja-JP")} 回再生</span></div>)}</div> : <p className="workspace-card__muted">対象動画はありません。</p>}</article>)}
  </section>;
}

function isConsultResult(value: unknown): value is WorkspaceConsultResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceConsultResult>;
  return typeof candidate.overallDiagnosis === "string" && [candidate.strongPoints, candidate.weakPoints, candidate.currentImprovements, candidate.nextSuggestions].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

export function ConsultView() {
  const { analysisResult, consultResult, setConsultResult, usageStatus, usageLoading, usageError, refreshUsage, refreshHistory, activeWriteAction, beginWriteAction, endWriteAction } = useAppWorkspace();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ClientErrorFeedback | null>(null);
  const inFlight = useRef(false);
  const summary = useMemo(() => analysisResult ? buildWorkspaceAISummary(analysisResult) : null, [analysisResult]);
  const canConsult = Boolean(summary && canRequestAIConsult(summary) && usageStatus && hasUsageRemaining(usageStatus.usage.aiConsult) && !loading && activeWriteAction === null);
  async function consult() {
    if (inFlight.current || !analysisResult || !summary || !canConsult || !beginWriteAction("consult")) return;
    inFlight.current = true; setLoading(true); setError(null); setConsultResult(null);
    try {
      const response = await fetch("/api/ai-consult", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiSummary: summary, analysisRunId: analysisResult.analysisRunId }) });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok || !isConsultResult(data)) { const feedback = getSafeClientApiErrorFeedback(response.status, data, "ai_consult"); setError(feedback); if (feedback.requiresUsageRefresh) await refreshUsage(); return; }
      setConsultResult(data); await Promise.all([refreshUsage(), refreshHistory()]);
    } catch (caught) {
      const refreshed = await refreshUsage();
      setError(getSafeClientNetworkErrorFeedback(caught instanceof DOMException && (caught.name === "AbortError" || caught.name === "TimeoutError") ? "timeout" : "network", refreshed !== null));
    } finally { inFlight.current = false; endWriteAction("consult"); setLoading(false); }
  }
  return <div className="workspace-page"><PageHeader eyebrow="AI CONSULT" title="AIコンサル" description="直前の分析結果を根拠に、次の改善候補を整理します。自由質問には対応していません。" />
    {!analysisResult ? <EmptyState title="先に動画分析が必要です">AI提案は、この画面を開く前に実行した分析結果だけを使います。保存済み履歴から内容を推測しません。<Link className="workspace-button workspace-button--primary" href="/app/analysis">動画分析へ</Link></EmptyState> : <><section className="workspace-card"><p><strong>対象：</strong>{analysisResult.channelTitle}</p>{usageLoading ? <StatusPanel tone="loading" title="利用枠を確認しています" /> : usageError ? <StatusPanel tone="error" title="利用枠を確認できません">{usageError}</StatusPanel> : usageStatus && <p className="workspace-inline-note">AI提案枠：本日残り {usageStatus.usage.aiConsult.daily.remaining} 回／今月残り {usageStatus.usage.aiConsult.monthly.remaining} 回</p>}<button type="button" className="workspace-button workspace-button--primary" disabled={!canConsult} aria-busy={loading} onClick={consult}>{loading ? "提案を作成しています…" : "AI提案を作成"}</button></section>{error && <StatusPanel tone="error" title={error.title}>{error.message}</StatusPanel>}{consultResult && <ConsultResults result={consultResult} />}</>}
  </div>;
}

function ConsultResults({ result }: { result: WorkspaceConsultResult }) {
  return <section className="workspace-stack"><article className="workspace-card workspace-card--accent"><p className="workspace-card__eyebrow">DIAGNOSIS</p><h2>何が起きているか</h2><p>{result.overallDiagnosis}</p></article><div className="workspace-grid workspace-grid--three"><article className="workspace-card"><h2>伸ばす強み</h2><ul className="workspace-list">{result.strongPoints.map((item) => <li key={item}>{item}</li>)}</ul></article><article className="workspace-card"><h2>弱み</h2><ul className="workspace-list">{result.weakPoints.map((item) => <li key={item}>{item}</li>)}</ul></article><article className="workspace-card"><h2>優先する改善</h2><ul className="workspace-list workspace-list--accent">{result.currentImprovements.map((item) => <li key={item}>{item}</li>)}</ul></article></div><article className="workspace-card"><h2>具体的な次の提案</h2><ul className="workspace-list">{result.nextSuggestions.map((item) => <li key={item}>{item}</li>)}</ul><Link className="workspace-button workspace-button--primary" href="/app/improvements">改善項目にする</Link></article></section>;
}

export function ImprovementsView() {
  const { analysisResult, consultResult, history, historyLoading, historyError, replaceHistory } = useAppWorkspace();
  return <div className="workspace-page"><PageHeader eyebrow="ACTION" title="改善サイクル" description="分析を1つの行動へ落とし込み、実行後の結果を記録します。" />{historyLoading ? <StatusPanel tone="loading" title="改善サイクルを読み込んでいます" /> : historyError && !history ? <StatusPanel tone="error" title="改善サイクルを表示できません">{historyError}</StatusPanel> : <WeeklyImprovementCycle currentAnalysisRunId={analysisResult?.analysisRunId ?? null} suggestedAction={consultResult?.currentImprovements[0] ?? consultResult?.nextSuggestions[0] ?? ""} refreshKey={0} initialHistory={history} onHistoryChange={replaceHistory} />}</div>;
}

export function HistoryView() {
  const { history, historyLoading, historyLoadingMore, historyError, loadMoreHistory } = useAppWorkspace();
  const [filter, setFilter] = useState<"analysis" | "consult" | "action">("analysis");
  const visible = (history?.items ?? []).filter((item) => filter === "analysis" || (filter === "consult" ? item.hasAIConsult : item.action !== null));
  return <div className="workspace-page"><PageHeader eyebrow="HISTORY" title="履歴" description="保存済みの分析、AI提案の有無、改善項目を時系列で確認します。" />
    <div className="workspace-tabs" role="group" aria-label="履歴の種類">{([{ value: "analysis", label: "分析履歴" }, { value: "consult", label: "AI提案履歴" }, { value: "action", label: "改善項目あり" }] as const).map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>
    {historyLoading ? <StatusPanel tone="loading" title="履歴を読み込んでいます" /> : historyError && !history ? <StatusPanel tone="error" title="履歴を表示できません">{historyError}</StatusPanel> : !history?.items.length ? <EmptyState title="履歴はまだありません">動画分析を行うと、ここに保存済みの要約が表示されます。</EmptyState> : <section className="workspace-history-list">{visible.map((item) => <article className="workspace-card" key={item.id}><div className="workspace-card__heading"><div><h2>{item.channelTitle}</h2><span>{formatDate(item.analyzedAt)}</span></div><span className="workspace-status-badge">{item.action?.status ?? (item.hasAIConsult ? "AI提案あり" : "分析のみ")}</span></div><dl className="workspace-history-metrics"><div><dt>通常動画</dt><dd>{item.regularVideoCount}本／平均 {item.regularAverageViews.toLocaleString("ja-JP")}回</dd></div><div><dt>Shorts</dt><dd>{item.shortVideoCount}本／平均 {item.shortAverageViews.toLocaleString("ja-JP")}回</dd></div></dl>{item.action && <p><strong>改善項目：</strong>{item.action.title}</p>}</article>)}{visible.length === 0 && <EmptyState title="該当する履歴はありません">絞り込み条件を変更してください。</EmptyState>}{history.nextCursor && <button type="button" className="workspace-button workspace-button--secondary" disabled={historyLoadingMore} onClick={() => void loadMoreHistory()}>{historyLoadingMore ? "読み込み中…" : "さらに10件読み込む"}</button>}{historyError && <StatusPanel tone="error" title="続きの履歴を読み込めません">{historyError}</StatusPanel>}</section>}
  </div>;
}

export function PlanView() {
  const { usageStatus, usageLoading, usageError } = useAppWorkspace();
  return <div className="workspace-page"><PageHeader eyebrow="PLAN" title="プラン・利用状況" description="現在適用されているプランと、サーバーが返した利用枠を表示します。" />{usageLoading ? <StatusPanel tone="loading" title="利用状況を確認しています" /> : usageError || !usageStatus ? <StatusPanel tone="error" title="利用状況を表示できません">{usageError}</StatusPanel> : <><section className="workspace-card"><p className="workspace-card__eyebrow">CURRENT PLAN</p><h2>{usageStatus.plan.code}</h2><div className="usage-grid"><UsageMetric label="分析（日次）" {...usageStatus.usage.channelAnalysis.daily} /><UsageMetric label="分析（月次）" {...usageStatus.usage.channelAnalysis.monthly} /><UsageMetric label="AI提案（日次）" {...usageStatus.usage.aiConsult.daily} /><UsageMetric label="AI提案（月次）" {...usageStatus.usage.aiConsult.monthly} /></div><p className="workspace-inline-note">1回の分析で通常動画 最大{usageStatus.plan.regularVideoLimit}本、Shorts 最大{usageStatus.plan.shortsVideoLimit}本</p></section><section className="workspace-plan-grid"><article className="workspace-card workspace-card--selected"><span className="workspace-status-badge">現在のプラン</span><h2>Free</h2><p>現在利用できる基本プランです。</p></article><article className="workspace-card"><span className="workspace-status-badge">将来候補</span><h2>Standard</h2><p>提供内容、価格、開始日は未定です。</p></article><article className="workspace-card"><span className="workspace-status-badge">将来候補</span><h2>Pro</h2><p>提供内容、価格、開始日は未定です。</p></article></section></>}
  </div>;
}

export function SettingsView() {
  const { user, ownedChannels, channelsLoading, channelsError, selectedOwnedChannelId } = useAppWorkspace();
  const [reset, setReset] = useState(false);
  function resetGuide() { try { window.localStorage.removeItem(BETA_ONBOARDING_DISMISSED_KEY); setReset(true); } catch { setReset(false); } }
  return <div className="workspace-page"><PageHeader eyebrow="SETTINGS" title="設定" description="アカウントと接続中の所有チャンネルを確認します。" /><section className="workspace-grid workspace-grid--two"><article className="workspace-card"><h2>アカウント</h2><dl className="workspace-settings-list"><div><dt>表示名</dt><dd>{user.name}</dd></div><div><dt>メール</dt><dd>{user.email}</dd></div></dl><SignOutButton /></article><article className="workspace-card"><h2>YouTube接続</h2>{channelsLoading ? <StatusPanel tone="loading" title="接続を確認しています" /> : channelsError ? <StatusPanel tone="error" title="接続を確認できません">{channelsError}</StatusPanel> : <p>{ownedChannels.find((channel) => channel.id === selectedOwnedChannelId)?.title ?? `${ownedChannels.length}件の所有チャンネル`}</p>}<p className="workspace-card__muted">この画面からOAuth scopeやGoogle Cloud設定は変更しません。</p></article></section><section className="workspace-card"><h2>初回ガイド</h2><p>閉じたガイドを、履歴が0件のときに再表示できる状態へ戻します。</p><button type="button" className="workspace-button workspace-button--secondary" onClick={resetGuide}>初回ガイドの非表示を解除</button>{reset && <p role="status" className="workspace-inline-note">設定を解除しました。履歴が0件の場合、次回表示されます。</p>}</section></div>;
}

export function SupportView() {
  return <div className="workspace-page"><PageHeader eyebrow="SUPPORT" title="サポート" description="クローズドβで迷いやすい操作と、安全上の前提を確認できます。" /><section className="workspace-faq"><details open><summary>分析できるチャンネルは？</summary><p>Googleログイン中の本人が所有するチャンネルだけです。任意のチャンネルIDは入力できません。</p></details><details><summary>動画が0件のとき利用枠は減りますか？</summary><p>取得できる通常動画・Shortsがどちらもない場合は、分析履歴を作成せず利用枠を解放します。</p></details><details><summary>AIコンサルへ自由に質問できますか？</summary><p>現在はできません。AIコンサルは直前の分析結果から提案を作成する機能です。</p></details><details><summary>Standard／Proは契約できますか？</summary><p>現在は将来候補です。価格や申込機能は提供していません。</p></details><details><summary>問題が起きたときは？</summary><p>再試行案内が表示された場合だけ案内に従ってください。認証情報や接続情報を画面へ貼り付けないでください。</p></details></section></div>;
}
