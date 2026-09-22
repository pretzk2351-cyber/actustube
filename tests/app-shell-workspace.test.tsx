// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, createElement, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/app/components/app-shell";
import { AppWorkspaceProvider, useAppWorkspace } from "@/app/components/app-workspace-provider";
import {
  AnalysisView,
  ConsultView,
  DashboardView,
  HistoryView,
  ImprovementsView,
  PlanView,
  SettingsView,
  SupportView,
} from "@/app/components/workspace-views";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/dashboard",
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";

const usage = {
  plan: { effectivePlanId: "free", code: "free", kind: "free", source: "free_fallback", regularVideoLimit: 10, shortsVideoLimit: 10 },
  usage: {
    channelAnalysis: {
      daily: { used: 0, limit: 2, remaining: 2, resetAt: "2026-07-28T00:00:00.000Z" },
      monthly: { used: 0, limit: 5, remaining: 5, resetAt: "2026-08-01T00:00:00.000Z" },
    },
    aiConsult: {
      daily: { used: 0, limit: 1, remaining: 1, resetAt: "2026-07-28T00:00:00.000Z" },
      monthly: { used: 0, limit: 3, remaining: 3, resetAt: "2026-08-01T00:00:00.000Z" },
    },
  },
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function urlOf(input: RequestInfo | URL) {
  if (!input) return "<missing>";
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installReadOnlyFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const url = urlOf(input);
    if (url === "/api/usage/status") return response(usage);
    if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
    if (url === "/api/weekly-cycle?limit=10") return response({ items: [], plannedAction: null, nextCursor: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Provider({ children }: { children: React.ReactNode }) {
  return (
    <AppWorkspaceProvider
      user={{ name: "Beta user", email: "beta@example.test", image: null }}
    >
      {children}
    </AppWorkspaceProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const analysisSnapshot = {
  analysisRunId: "11111111-1111-4111-8111-111111111111",
  channelId: CHANNEL_ID,
  channelTitle: "Owner channel",
  regularVideos: [{ id: "video-1", title: "Saved analysis video", publishedAt: "2026-07-27T00:00:00.000Z", thumbnail: "", viewCount: "12" }],
  shortVideos: [],
};
const emptyHistory = { items: [], plannedAction: null, nextCursor: null };
const savedHistory = {
  ...emptyHistory,
  items: [{ id: analysisSnapshot.analysisRunId, channelId: CHANNEL_ID, channelTitle: "Saved history channel", analyzedAt: "2026-07-27T00:00:00.000Z", regularVideoCount: 1, shortVideoCount: 0, regularAverageViews: 12, shortAverageViews: 0, hasAIConsult: false, aiConsultCreatedAt: null, action: null }],
};
const consultSnapshot = { overallDiagnosis: "Saved diagnosis", strongPoints: ["Strong"], weakPoints: ["Weak"], currentImprovements: ["Improve"], nextSuggestions: ["Next"] };
const improvementAction = {
  id: "22222222-2222-4222-8222-222222222222", analysisRunId: analysisSnapshot.analysisRunId,
  title: "Original improvement", description: "Fixed improvement description", status: "planned" as const,
  resultNote: null, createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z", completedAt: null,
};
const improvementHistory = { ...savedHistory, plannedAction: improvementAction };

function installAsyncFetch({ history, operation, consult = false }: {
  history?: () => Promise<Response> | Response;
  operation: () => Promise<Response> | Response;
  consult?: boolean;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const url = urlOf(input);
    if (url === "/api/usage/status") return response(usage);
    if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
    if (url === "/api/weekly-cycle?limit=10") return history ? history() : response(emptyHistory);
    if (consult ? url === "/api/ai-consult" : url.startsWith("/api/youtube/channel?")) return operation();
    throw new Error("Unexpected test request");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function startOperation(consult = false) {
  const button = await screen.findByRole("button", { name: consult ? "AI提案を作成" : "動画を分析" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

async function saveImprovement() {
  const button = await screen.findByRole("button", { name: "内容を保存" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
}

function HistoryRefreshControl() {
  const { refreshHistory } = useAppWorkspace();
  return <button onClick={() => void refreshHistory()}>join history read</button>;
}

function AsyncRouteHarness({ consult = false }: { consult?: boolean }) {
  const { setAnalysisResult } = useAppWorkspace();
  const [route, setRoute] = useState("operation");
  useEffect(() => { if (consult) setAnalysisResult(analysisSnapshot); }, [consult, setAnalysisResult]);
  return <>
    <button onClick={() => setRoute("away")}>leave operation</button>
    <button onClick={() => setRoute("operation")}>return to operation</button>
    <button onClick={() => setRoute("history")}>show history</button>
    <button onClick={() => setRoute("improvements")}>show improvements</button>
    {route === "operation" ? consult ? <ConsultView /> : <AnalysisView /> : route === "history" ? <HistoryView /> : route === "improvements" ? <ImprovementsView /> : <p>away from operation</p>}
  </>;
}

describe("workspace async state regressions", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  for (const consult of [false, true]) {
    for (const order of ["old first", "fresh first"]) {
      it.each(["success", "http failure", "rejection"])(`keeps request-start ordering for a real improvement save callback (consult=${consult}, ${order}, %s)`, async (oldOutcome) => {
        const old = deferred<Response>();
        const fresh = deferred<Response>();
        const latest = { ...savedHistory, items: savedHistory.items.map((item) => ({ ...item, channelTitle: "Latest operation history", hasAIConsult: consult })) };
        let historyCalls = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = urlOf(input);
          if (url === "/api/usage/status") return response(usage);
          if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
          if (url === "/api/weekly-cycle?limit=10") {
            historyCalls += 1;
            if (historyCalls === 1) return response(improvementHistory);
            if (historyCalls === 2) return old.promise;
            if (historyCalls === 3) return fresh.promise;
          }
          if (url === `/api/weekly-cycle/actions/${improvementAction.id}` && init?.method === "PATCH") return response({ action: improvementAction });
          if (consult ? url === "/api/ai-consult" : url.startsWith("/api/youtube/channel?")) return response(consult ? consultSnapshot : analysisSnapshot);
          throw new Error("Unexpected test request");
        });
        vi.stubGlobal("fetch", fetchMock);
        render(<Provider><AsyncRouteHarness consult={consult} /><HistoryRefreshControl /></Provider>);
        const finishOld = async () => {
          await act(async () => {
            if (oldOutcome === "rejection") old.reject(new Error("private obsolete improvement error"));
            else old.resolve(response(improvementHistory, oldOutcome === "http failure" ? 500 : 200));
          });
        };
        try {
          fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
          await saveImprovement();
          await waitFor(() => expect(historyCalls).toBe(2));
          fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
          expect(screen.queryByRole("button", { name: "内容を保存" })).toBeNull();
          await startOperation(consult);
          await waitFor(() => expect(historyCalls).toBe(3));
          fireEvent.click(screen.getByRole("button", { name: "show history" }));
          if (order === "old first") {
            await finishOld();
            expect(screen.getByText("履歴を読み込んでいます")).toBeTruthy();
            fireEvent.click(screen.getByRole("button", { name: "join history read" }));
            expect(historyCalls).toBe(3);
          }
          await act(async () => { fresh.resolve(response(latest)); });
          expect(await screen.findByText("Latest operation history")).toBeTruthy();
          if (order === "fresh first") await finishOld();
          expect(screen.getByText("Latest operation history")).toBeTruthy();
          expect(screen.queryByText("Saved history channel")).toBeNull();
          expect(screen.queryByText("履歴を読み込んでいます")).toBeNull();
          expect(screen.queryByText("履歴の更新を確認してください")).toBeNull();
          fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
          expect(await screen.findByText(consult ? "Saved diagnosis" : "Saved analysis video")).toBeTruthy();
          expect(screen.queryByText(/は保存されましたが/)).toBeNull();
          fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
          expect(await screen.findByText("Latest operation history")).toBeTruthy();
          expect(screen.queryByDisplayValue("Original improvement")).toBeNull();
          expect(historyCalls).toBe(3);
          expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
          expect(fetchMock.mock.calls.filter(([input]) => consult ? urlOf(input) === "/api/ai-consult" : urlOf(input).startsWith("/api/youtube/channel?"))).toHaveLength(1);
          expect(screen.queryByText("private obsolete improvement error")).toBeNull();
        } finally {
          await act(async () => { old.resolve(response(improvementHistory)); fresh.resolve(response(latest)); });
        }
      });
    }
  }

  it.each([false, true])("applies the latest real improvement save after navigation (return before response=%s)", async (returnBeforeResponse) => {
    const pending = deferred<Response>();
    const updated = { ...improvementHistory, plannedAction: { ...improvementAction, title: "Updated improvement" } };
    let historyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return ++historyCalls === 1 ? response(improvementHistory) : pending.promise;
      if (url === `/api/weekly-cycle/actions/${improvementAction.id}` && init?.method === "PATCH") return response({ action: updated.plannedAction });
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
      fireEvent.change(await screen.findByLabelText("タイトル"), { target: { value: "Updated improvement" } });
      await saveImprovement();
      await waitFor(() => expect(historyCalls).toBe(2));
      fireEvent.click(screen.getByRole("button", { name: "leave operation" }));
      if (returnBeforeResponse) fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
      await act(async () => { pending.resolve(response(updated)); });
      if (!returnBeforeResponse) fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
      expect(await screen.findByDisplayValue("Updated improvement")).toBeTruthy();
      expect(historyCalls).toBe(2);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    } finally {
      await act(async () => { pending.resolve(response(updated)); });
    }
  });

  it("keeps the in-place real improvement save result and notice without remounting or refetching", async () => {
    const updated = { ...improvementHistory, plannedAction: { ...improvementAction, title: "Updated improvement" } };
    let historyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return response(++historyCalls === 1 ? improvementHistory : updated);
      if (url === `/api/weekly-cycle/actions/${improvementAction.id}` && init?.method === "PATCH") return response({ action: updated.plannedAction });
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Provider><AsyncRouteHarness /></Provider>);
    fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
    const title = await screen.findByLabelText("タイトル");
    fireEvent.change(title, { target: { value: "Updated improvement" } });
    await saveImprovement();
    expect(await screen.findByText("改善項目を更新しました。")).toBeTruthy();
    expect(screen.getByDisplayValue("Updated improvement")).toBe(title);
    expect(historyCalls).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["earlier GET first", "later GET first"])("takes improvement request ownership at GET start after a delayed PATCH, not at save or completion (%s)", async (order) => {
    const patch = deferred<Response>();
    const earlier = deferred<Response>();
    const later = deferred<Response>();
    const latest = { ...savedHistory, items: savedHistory.items.map((item) => ({ ...item, channelTitle: "Latest improvement history" })) };
    let historyCalls = 0;
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") {
        historyCalls += 1;
        events.push(`history ${historyCalls}`);
        if (historyCalls === 1) return response(improvementHistory);
        if (historyCalls === 2) return earlier.promise;
        if (historyCalls === 3) return later.promise;
      }
      if (url === `/api/weekly-cycle/actions/${improvementAction.id}` && init?.method === "PATCH") { events.push("patch"); return patch.promise; }
      if (url.startsWith("/api/youtube/channel?")) { events.push("analysis"); return response(analysisSnapshot); }
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
      await saveImprovement();
      fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      await startOperation();
      await waitFor(() => expect(historyCalls).toBe(2));
      await act(async () => { patch.resolve(response({ action: improvementAction })); });
      expect(events).toEqual(["history 1", "patch", "analysis", "history 2", "history 3"]);
      fireEvent.click(screen.getByRole("button", { name: "show history" }));
      if (order === "earlier GET first") {
        await act(async () => { earlier.resolve(response(savedHistory)); });
        expect(screen.getByText("履歴を読み込んでいます")).toBeTruthy();
      }
      await act(async () => { later.resolve(response(latest)); });
      if (order === "later GET first") await act(async () => { earlier.resolve(response(savedHistory)); });
      expect(await screen.findByText("Latest improvement history")).toBeTruthy();
      expect(screen.queryByText("Saved history channel")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      expect(await screen.findByText("Saved analysis video")).toBeTruthy();
      expect(screen.queryByText(/は保存されましたが/)).toBeNull();
      expect(historyCalls).toBe(3);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?"))).toHaveLength(1);
    } finally {
      await act(async () => { patch.resolve(response({ action: improvementAction })); earlier.resolve(response(savedHistory)); later.resolve(response(latest)); });
    }
  });

  it.each([
    { outcome: "success", oldFirst: false }, { outcome: "rejection", oldFirst: false },
    { outcome: "success", oldFirst: true }, { outcome: "rejection", oldFirst: true },
    { outcome: "http failure", oldFirst: true },
  ])("rejects an obsolete real improvement cursor after a new Provider GET starts: $outcome, old first=$oldFirst", async ({ outcome, oldFirst }) => {
    const analysis = deferred<Response>();
    const cursor = deferred<Response>();
    const fresh = deferred<Response>();
    let historyCalls = 0;
    const latest = { ...savedHistory, items: savedHistory.items.map((item) => ({ ...item, channelTitle: "Latest operation history" })) };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return ++historyCalls === 1 ? response({ ...improvementHistory, nextCursor: "fixed-test-cursor" }) : fresh.promise;
      if (url === "/api/weekly-cycle?limit=10&cursor=fixed-test-cursor") return cursor.promise;
      if (url.startsWith("/api/youtube/channel?")) return analysis.promise;
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      await startOperation();
      fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
      fireEvent.click(await screen.findByRole("button", { name: "さらに表示" }));
      await act(async () => { analysis.resolve(response(analysisSnapshot)); });
      await waitFor(() => expect(historyCalls).toBe(2));
      const finishCursor = async () => {
        await act(async () => {
          if (outcome === "rejection") cursor.reject(new Error("private obsolete cursor error"));
          else cursor.resolve(response({ ...savedHistory, items: savedHistory.items.map((item) => ({ ...item, id: "obsolete-cursor-item", channelTitle: "Obsolete cursor history" })) }, outcome === "http failure" ? 500 : 200));
        });
      };
      if (oldFirst) {
        await finishCursor();
        expect(screen.queryByText("Obsolete cursor history")).toBeNull();
        expect(screen.queryByText("履歴の続きを読み込めませんでした。")).toBeNull();
        expect(screen.queryByText("週次改善サイクルの更新に失敗しました。")).toBeNull();
        expect(screen.getByRole("button", { name: "読み込み中..." })).toHaveProperty("disabled", true);
      }
      await act(async () => { fresh.resolve(response(latest)); });
      expect(await screen.findByText("Latest operation history")).toBeTruthy();
      if (!oldFirst) await finishCursor();
      expect(screen.getByText("Latest operation history")).toBeTruthy();
      expect(screen.queryByText("Obsolete cursor history")).toBeNull();
      expect(screen.queryByText("履歴の続きを読み込めませんでした。")).toBeNull();
      expect(screen.queryByText("週次改善サイクルの更新に失敗しました。")).toBeNull();
      expect(screen.queryByRole("button", { name: "さらに表示" })).toBeNull();
      expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).includes("cursor=")).length).toBe(1);
    } finally {
      await act(async () => { analysis.resolve(response(analysisSnapshot)); cursor.resolve(response(emptyHistory)); fresh.resolve(response(latest)); });
    }
  });

  for (const consult of [false, true]) {
    for (const oldFirst of [false, true]) {
      it.each(["success", "rejection", "http failure"])(`does not misclassify a superseded real improvement save while its view stays mounted (consult=${consult}, old first=${oldFirst}, %s)`, async (outcome) => {
        const operation = deferred<Response>();
        const old = deferred<Response>();
        const fresh = deferred<Response>();
        const latest = { ...improvementHistory, items: savedHistory.items.map((item) => ({ ...item, channelTitle: "Latest mounted history" })) };
        let historyCalls = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = urlOf(input);
          if (url === "/api/usage/status") return response(usage);
          if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
          if (url === "/api/weekly-cycle?limit=10") {
            historyCalls += 1;
            if (historyCalls === 1) return response(improvementHistory);
            if (historyCalls === 2) return old.promise;
            if (historyCalls === 3) return fresh.promise;
          }
          if (url === `/api/weekly-cycle/actions/${improvementAction.id}` && init?.method === "PATCH") return response({ action: improvementAction });
          if (consult ? url === "/api/ai-consult" : url.startsWith("/api/youtube/channel?")) return operation.promise;
          throw new Error("Unexpected test request");
        });
        vi.stubGlobal("fetch", fetchMock);
        render(<Provider><AsyncRouteHarness consult={consult} /></Provider>);
        try {
          await startOperation(consult);
          fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
          const title = await screen.findByLabelText("タイトル");
          await saveImprovement();
          await waitFor(() => expect(historyCalls).toBe(2));
          await act(async () => { operation.resolve(response(consult ? consultSnapshot : analysisSnapshot)); });
          await waitFor(() => expect(historyCalls).toBe(3));
          const finishOld = async () => {
            await act(async () => {
              if (outcome === "rejection") old.reject(new Error("private obsolete save error"));
              else old.resolve(response(improvementHistory, outcome === "http failure" ? 500 : 200));
            });
          };
          if (oldFirst) await finishOld();
          await act(async () => { fresh.resolve(response(latest)); });
          if (!oldFirst) await finishOld();
          expect(await screen.findByText("Latest mounted history")).toBeTruthy();
          expect(screen.getByLabelText("タイトル")).toBe(title);
          expect(screen.queryByText(/最新の履歴を読み込めませんでした/)).toBeNull();
          expect(screen.queryByText("週次改善サイクルを読み込めませんでした。")).toBeNull();
          expect(screen.queryByText("週次改善サイクルの更新に失敗しました。")).toBeNull();
          expect(screen.queryByText("履歴の更新を確認してください")).toBeNull();
          expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
          expect(fetchMock.mock.calls.filter(([input]) => consult ? urlOf(input) === "/api/ai-consult" : urlOf(input).startsWith("/api/youtube/channel?"))).toHaveLength(1);
          expect(historyCalls).toBe(3);
        } finally {
          await act(async () => { operation.resolve(response(consult ? consultSnapshot : analysisSnapshot)); old.resolve(response(improvementHistory)); fresh.resolve(response(latest)); });
        }
      });
    }
  }

  it("starts fresh history after analysis while the initial GET is pending", async () => {
    const initial = deferred<Response>();
    const fresh = deferred<Response>();
    let historyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return ++historyCalls === 1 ? initial.promise : fresh.promise;
      if (url.startsWith("/api/youtube/channel?")) return response(analysisSnapshot);
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      const analyze = await screen.findByRole("button", { name: "動画を分析" });
      await waitFor(() => expect((analyze as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(analyze);
      await screen.findByText("Saved analysis video");
      await waitFor(() => expect(historyCalls).toBe(2));
      await act(async () => { fresh.resolve(response(savedHistory)); });
      await act(async () => { initial.resolve(response(emptyHistory)); });
      fireEvent.click(screen.getByRole("button", { name: "show history" }));
      expect(await screen.findByText("Saved history channel")).toBeTruthy();
      expect(screen.queryByText("履歴はまだありません")).toBeNull();
      expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(1);
    } finally {
      await act(async () => { initial.resolve(response(emptyHistory)); fresh.resolve(response(savedHistory)); });
    }
  });

  it("retains an unknown network outcome after the analysis route remounts", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return response(emptyHistory);
      if (url.startsWith("/api/youtube/channel?")) return pending.promise;
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      const analyze = await screen.findByRole("button", { name: "動画を分析" });
      await waitFor(() => expect((analyze as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(analyze);
      fireEvent.click(screen.getByRole("button", { name: "leave operation" }));
      fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      await act(async () => { pending.reject(new Error("private test error detail")); });
      expect(await screen.findByText(/処理結果が不明なため/)).toBeTruthy();
      expect(screen.queryByText("private test error detail")).toBeNull();
      expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(1);
    } finally {
      await act(async () => { pending.resolve(response(analysisSnapshot)); });
    }
  });

  it.each(["success", "http failure", "rejection"])("ignores old history %s and its finally while fresh history is pending", async (oldOutcome) => {
    const initial = deferred<Response>();
    const fresh = deferred<Response>();
    let historyCalls = 0;
    installAsyncFetch({ history: () => ++historyCalls === 1 ? initial.promise : fresh.promise, operation: () => response(analysisSnapshot) });
    render(<Provider><AsyncRouteHarness /><HistoryRefreshControl /></Provider>);
    try {
      await startOperation();
      await waitFor(() => expect(historyCalls).toBe(2));
      fireEvent.click(screen.getByRole("button", { name: "show history" }));
      await act(async () => {
        if (oldOutcome === "rejection") initial.reject(new Error("private old request error"));
        else initial.resolve(response(emptyHistory, oldOutcome === "http failure" ? 500 : 200));
      });
      expect(screen.getByText("履歴を読み込んでいます")).toBeTruthy();
      expect(screen.queryByText("履歴を表示できません")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "join history read" }));
      expect(historyCalls).toBe(2);
      await act(async () => { fresh.resolve(response(savedHistory)); });
      expect(await screen.findByText("Saved history channel")).toBeTruthy();
      expect(screen.queryByText("履歴を読み込んでいます")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      expect(await screen.findByText("Saved analysis video")).toBeTruthy();
      expect(screen.queryByText(/は保存されましたが/)).toBeNull();
    } finally {
      await act(async () => { initial.resolve(response(emptyHistory)); fresh.resolve(response(savedHistory)); });
    }
  });

  it.each(["http failure", "rejection"])("ignores late old history %s after fresh success", async (oldOutcome) => {
    const initial = deferred<Response>();
    const fresh = deferred<Response>();
    let historyCalls = 0;
    installAsyncFetch({ history: () => ++historyCalls === 1 ? initial.promise : fresh.promise, operation: () => response(analysisSnapshot) });
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      await startOperation();
      await waitFor(() => expect(historyCalls).toBe(2));
      await act(async () => { fresh.resolve(response(savedHistory)); });
      fireEvent.click(screen.getByRole("button", { name: "show history" }));
      expect(await screen.findByText("Saved history channel")).toBeTruthy();
      await act(async () => {
        if (oldOutcome === "rejection") initial.reject(new Error("private old request error"));
        else initial.resolve(response(emptyHistory, 500));
      });
      expect(screen.getByText("Saved history channel")).toBeTruthy();
      expect(screen.queryByText("履歴を表示できません")).toBeNull();
      expect(screen.queryByText("履歴を読み込んでいます")).toBeNull();
    } finally {
      await act(async () => { initial.resolve(response(emptyHistory)); fresh.resolve(response(savedHistory)); });
    }
  });

  it.each([
    { consult: false, existingHistory: false }, { consult: true, existingHistory: false },
    { consult: false, existingHistory: true }, { consult: true, existingHistory: true },
  ])("preserves a saved result when only its history refresh fails (consult=$consult, existingHistory=$existingHistory)", async ({ consult, existingHistory }) => {
    const fresh = deferred<Response>();
    let historyCalls = 0;
    const fetchMock = installAsyncFetch({ consult, history: () => ++historyCalls === 1 ? response(existingHistory ? savedHistory : emptyHistory) : fresh.promise, operation: () => response(consult ? consultSnapshot : analysisSnapshot) });
    render(<Provider><AsyncRouteHarness consult={consult} /></Provider>);
    try {
      await startOperation(consult);
      await waitFor(() => expect(historyCalls).toBe(2));
      fireEvent.click(screen.getByRole("button", { name: "leave operation" }));
      await act(async () => { fresh.resolve(response({ error: "private test refresh error" }, 500)); });
      fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      expect(await screen.findByText(consult ? "Saved diagnosis" : "Saved analysis video")).toBeTruthy();
      expect(screen.getByText(/は保存されましたが/)).toBeTruthy();
      expect(screen.queryByText("private test refresh error")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "show history" }));
      expect(await screen.findByText(existingHistory ? "履歴の更新を確認してください" : "履歴を表示できません")).toBeTruthy();
      if (existingHistory) expect(screen.getByText("Saved history channel")).toBeTruthy();
      expect(screen.queryByText("履歴はまだありません")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "show improvements" }));
      expect(await screen.findByText(existingHistory ? "履歴の更新を確認してください" : "改善サイクルを表示できません")).toBeTruthy();
      const writes = fetchMock.mock.calls.filter(([input]) => consult ? urlOf(input) === "/api/ai-consult" : urlOf(input).startsWith("/api/youtube/channel?"));
      expect(writes.length).toBe(1);
      if (consult) expect(writes[0][1]?.method).toBe("POST");
    } finally {
      await act(async () => { fresh.resolve(response(savedHistory)); });
    }
  });

  it("starts fresh history after an AI consult and keeps its updated history flag", async () => {
    const initial = deferred<Response>();
    const fresh = deferred<Response>();
    let historyCalls = 0;
    const fetchMock = installAsyncFetch({ consult: true, history: () => ++historyCalls === 1 ? initial.promise : fresh.promise, operation: () => response(consultSnapshot) });
    render(<Provider><AsyncRouteHarness consult /></Provider>);
    try {
      await startOperation(true);
      await waitFor(() => expect(historyCalls).toBe(2));
      await act(async () => { fresh.resolve(response({ ...savedHistory, items: savedHistory.items.map((item) => ({ ...item, hasAIConsult: true, aiConsultCreatedAt: "2026-07-27T01:00:00.000Z" })) })); });
      await act(async () => { initial.resolve(response(savedHistory)); });
      fireEvent.click(screen.getByRole("button", { name: "show history" }));
      expect(await screen.findByText("AI提案あり")).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([input, init]) => urlOf(input) === "/api/ai-consult" && init?.method === "POST").length).toBe(1);
    } finally {
      await act(async () => { initial.resolve(response(emptyHistory)); fresh.resolve(response(savedHistory)); });
    }
  });

  for (const consult of [false, true]) {
    for (const returnBeforeCompletion of [false, true]) {
      it.each(["http", "network"])(`retains %s failure across real route remount (consult=${consult}, returnBeforeCompletion=${returnBeforeCompletion})`, async (failure) => {
        const pending = deferred<Response>();
        const fetchMock = installAsyncFetch({ consult, operation: () => pending.promise });
        render(<Provider><AsyncRouteHarness consult={consult} /></Provider>);
        try {
          await startOperation(consult);
          fireEvent.click(screen.getByRole("button", { name: "leave operation" }));
          expect(screen.queryByRole("heading", { name: consult ? "AIコンサル" : "動画分析" })).toBeNull();
          if (returnBeforeCompletion) {
            fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
            const busy = screen.getByRole("button", { name: consult ? "提案を作成しています…" : "分析しています…" });
            expect((busy as HTMLButtonElement).disabled).toBe(true);
            expect(busy.getAttribute("aria-busy")).toBe("true");
            fireEvent.click(busy);
          }
          await act(async () => {
            if (failure === "network") pending.reject(new Error("private mutation failure"));
            else pending.resolve(response({ error: "private mutation failure" }, 502));
          });
          if (!returnBeforeCompletion) fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
          const notice = await screen.findByRole("alert");
          expect(notice.textContent).not.toContain("private mutation failure");
          if (failure === "network") expect(notice.textContent).toContain("処理結果が不明なため");
          expect(screen.queryByText("分析前です")).toBeNull();
          const button = screen.getByRole("button", { name: consult ? "AI提案を作成" : "動画を分析" });
          await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
          expect(fetchMock.mock.calls.filter(([input]) => consult ? urlOf(input) === "/api/ai-consult" : urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(1);
        } finally {
          await act(async () => { pending.resolve(response(consult ? consultSnapshot : analysisSnapshot)); });
        }
      });
    }
  }

  it.each([false, true])("retains a zero-video result across route remount (returnBeforeCompletion=%s)", async (returnBeforeCompletion) => {
    const pending = deferred<Response>();
    const fetchMock = installAsyncFetch({ operation: () => pending.promise });
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      await startOperation();
      fireEvent.click(screen.getByRole("button", { name: "leave operation" }));
      if (returnBeforeCompletion) fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      await act(async () => { pending.resolve(response({ channelId: CHANNEL_ID, channelTitle: "Empty owner channel", regularVideos: [], shortVideos: [], empty: true, code: "NO_ANALYZABLE_VIDEOS", usageConsumed: false, historySaved: false })); });
      if (!returnBeforeCompletion) fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      expect(await screen.findByText("分析できる動画がありません")).toBeTruthy();
      expect(screen.getByText(/利用枠と履歴は消費されません/)).toBeTruthy();
      expect(screen.queryByText("分析前です")).toBeNull();
      expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(1);
    } finally {
      await act(async () => { pending.resolve(response(analysisSnapshot)); });
    }
  });

  it("does not let an old history failure unlock or replace the next operation", async () => {
    const initial = deferred<Response>();
    const second = deferred<Response>();
    let historyCalls = 0;
    let operationCalls = 0;
    const fetchMock = installAsyncFetch({ history: () => ++historyCalls === 1 ? initial.promise : response(savedHistory), operation: () => ++operationCalls === 1 ? response(analysisSnapshot) : second.promise });
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      await startOperation();
      expect(await screen.findByText("Saved analysis video")).toBeTruthy();
      await startOperation();
      await act(async () => { initial.reject(new Error("private obsolete failure")); });
      const busy = screen.getByRole("button", { name: "分析しています…" });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(busy);
      expect(operationCalls).toBe(2);
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { second.resolve(response({ ...analysisSnapshot, regularVideos: [{ ...analysisSnapshot.regularVideos[0], title: "Second saved result" }] })); });
      expect(await screen.findByText("Second saved result")).toBeTruthy();
      expect(screen.queryByText("Saved analysis video")).toBeNull();
      expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(2);
    } finally {
      await act(async () => { initial.resolve(response(emptyHistory)); second.resolve(response(analysisSnapshot)); });
    }
  });

  it("clears the previous failure only when a new operation starts and keeps the new pending state", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let operationCalls = 0;
    installAsyncFetch({ operation: () => ++operationCalls === 1 ? first.promise : second.promise });
    render(<Provider><AsyncRouteHarness /></Provider>);
    try {
      await startOperation();
      await act(async () => { first.reject(new Error("private first failure")); });
      expect(await screen.findByText(/処理結果が不明なため/)).toBeTruthy();
      await startOperation();
      expect(screen.queryByText(/処理結果が不明なため/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "leave operation" }));
      fireEvent.click(screen.getByRole("button", { name: "return to operation" }));
      expect((screen.getByRole("button", { name: "分析しています…" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { second.resolve(response(analysisSnapshot)); });
      expect(await screen.findByText("Saved analysis video")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(operationCalls).toBe(2);
    } finally {
      await act(async () => { first.resolve(response(analysisSnapshot)); second.resolve(response(analysisSnapshot)); });
    }
  });

  it("does not transfer a pending result or lock to a different Provider user", async () => {
    const previousUser = deferred<Response>();
    const nextUser = deferred<Response>();
    let operationCalls = 0;
    installAsyncFetch({ operation: () => ++operationCalls === 1 ? previousUser.promise : nextUser.promise });
    const view = (email: string) => <AppWorkspaceProvider user={{ name: "Test user", email, image: null }}><AsyncRouteHarness /></AppWorkspaceProvider>;
    const rendered = render(view("first@example.test"));
    try {
      await startOperation();
      rendered.rerender(view("second@example.test"));
      await startOperation();
      await act(async () => { previousUser.resolve(response(analysisSnapshot)); });
      expect(screen.queryByText("Saved analysis video")).toBeNull();
      expect((screen.getByRole("button", { name: "分析しています…" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { nextUser.resolve(response({ ...analysisSnapshot, regularVideos: [{ ...analysisSnapshot.regularVideos[0], title: "New user result" }] })); });
      expect(await screen.findByText("New user result")).toBeTruthy();
      expect(screen.queryByText("Saved analysis video")).toBeNull();
    } finally {
      await act(async () => { previousUser.resolve(response(analysisSnapshot)); nextUser.resolve(response(analysisSnapshot)); });
    }
  });

  it("does not transfer a previous channel result or notice to another channel", async () => {
    const fetchMock = installAsyncFetch({ operation: () => response(analysisSnapshot) });
    function ChannelControl() {
      const { refreshOwnedChannels } = useAppWorkspace();
      return <button onClick={() => void refreshOwnedChannels()}>update channels</button>;
    }
    render(<Provider><AsyncRouteHarness /><ChannelControl /></Provider>);
    await startOperation();
    expect(await screen.findByText("Saved analysis video")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("所有チャンネル") as HTMLSelectElement).disabled).toBe(false));
    fetchMock.mockImplementationOnce(async () => response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }, { id: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "Other owner channel" }] }));
    fireEvent.click(screen.getByRole("button", { name: "update channels" }));
    await screen.findByRole("option", { name: "Other owner channel" });
    fireEvent.change(screen.getByLabelText("所有チャンネル"), { target: { value: "UCbbbbbbbbbbbbbbbbbbbbbb" } });
    expect(screen.queryByText("Saved analysis video")).toBeNull();
    expect(screen.getByText("分析前です")).toBeTruthy();
  });

  for (const replacement of ["refresh", "replace"] as const) {
    it.each(["old success first", "old rejection first", "fresh first"])(`never reuses an invalidated cursor GET after ${replacement}: %s`, async (order) => {
      const oldPage = deferred<Response>();
      const newPage = deferred<Response>();
      const firstPage = { ...savedHistory, nextCursor: "fixed-test-cursor" };
      const updatedFirstPage = { ...firstPage, items: firstPage.items.map((item) => ({ ...item, channelTitle: "Updated first page" })) };
      const page = (title: string) => ({ ...emptyHistory, items: savedHistory.items.map((item) => ({ ...item, id: "22222222-2222-4222-8222-222222222222", channelTitle: title })) });
      let firstPageCalls = 0;
      let cursorCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url === "/api/usage/status") return response(usage);
        if (url === "/api/youtube/my-channels") return response({ channels: [] });
        if (url === "/api/weekly-cycle?limit=10") return response(++firstPageCalls === 1 ? firstPage : updatedFirstPage);
        if (url === "/api/weekly-cycle?limit=10&cursor=fixed-test-cursor") return ++cursorCalls === 1 ? oldPage.promise : newPage.promise;
        throw new Error("Unexpected test request");
      });
      vi.stubGlobal("fetch", fetchMock);
      function ReplaceControl() {
        const { refreshHistory, beginHistoryUpdate } = useAppWorkspace();
        return <button onClick={() => replacement === "refresh" ? void refreshHistory(true) : beginHistoryUpdate()(updatedFirstPage)}>new first page</button>;
      }
      render(<Provider><HistoryView /><ReplaceControl /></Provider>);
      try {
        await screen.findByText("Saved history channel");
        fireEvent.click(screen.getByRole("button", { name: "さらに10件読み込む" }));
        expect(cursorCalls).toBe(1);
        fireEvent.click(screen.getByRole("button", { name: "new first page" }));
        await screen.findByText("Updated first page");
        fireEvent.click(screen.getByRole("button", { name: "さらに10件読み込む" }));
        expect(cursorCalls).toBe(2);
        if (order === "fresh first") {
          await act(async () => { newPage.resolve(response(page("Fresh added page"))); });
          await act(async () => { oldPage.resolve(response(page("Obsolete added page"))); });
        } else {
          await act(async () => {
            if (order === "old rejection first") oldPage.reject(new Error("private obsolete cursor error"));
            else oldPage.resolve(response(page("Obsolete added page")));
          });
          const busy = screen.getByRole("button", { name: "読み込み中…" });
          expect((busy as HTMLButtonElement).disabled).toBe(true);
          fireEvent.click(busy);
          expect(cursorCalls).toBe(2);
          expect(screen.queryByRole("alert")).toBeNull();
          await act(async () => { newPage.resolve(response(page("Fresh added page"))); });
        }
        expect(screen.getByText("Updated first page")).toBeTruthy();
        expect(await screen.findByText("Fresh added page")).toBeTruthy();
        expect(screen.queryByText("Obsolete added page")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(cursorCalls).toBe(2);
        expect(fetchMock.mock.calls.every(([input]) => !urlOf(input).includes("/api/ai-consult"))).toBe(true);
      } finally {
        await act(async () => { oldPage.resolve(response(emptyHistory)); newPage.resolve(response(emptyHistory)); });
      }
    });
  }
});

describe("authenticated app shell", () => {
  beforeEach(() => { installReadOnlyFetch(); });
  afterEach(() => { cleanup(); document.body.style.overflow = ""; vi.unstubAllGlobals(); });

  it("deduplicates initial read-only requests under Strict Mode", async () => {
    const fetchMock = vi.mocked(fetch);
    render(createElement(StrictMode, null, createElement(Provider, null, createElement("p", null, "content"))));
    await screen.findByText("content");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual([
      "/api/usage/status",
      "/api/youtube/my-channels",
      "/api/weekly-cycle?limit=10",
    ]);
  });

  it("opens an accessible mobile drawer, traps focus, closes on Escape, and returns focus", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390, writable: true });
    render(createElement(Provider, null, createElement(AppShell, null, createElement("p", null, "main area"))));
    const open = screen.getByRole("button", { name: "メニューを開く" });
    fireEvent.click(open);
    const drawer = screen.getByRole("dialog", { name: "アプリメニュー" });
    expect(drawer).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    const close = drawer.querySelector<HTMLButtonElement>('button[aria-label="メニューを閉じる"]');
    const signOut = drawer.querySelector<HTMLButtonElement>(".auth-button");
    expect(document.activeElement).toBe(close);
    signOut?.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    close?.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(signOut);
    expect(screen.getAllByRole("link", { name: "ダッシュボード" }).some((link) => link.getAttribute("aria-current") === "page")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "アプリメニュー" })).toBeNull());
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(open);
  });

  it("closes the drawer from the overlay or navigation and unlocks scroll at desktop width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390, writable: true });
    render(createElement(Provider, null, createElement(AppShell, null, createElement("p", null, "main area"))));
    const open = screen.getByRole("button", { name: "メニューを開く" });
    fireEvent.click(open);
    fireEvent.click(document.querySelector(".workspace-drawer-overlay") as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "アプリメニュー" })).toBeNull());

    fireEvent.click(open);
    const drawer = screen.getByRole("dialog", { name: "アプリメニュー" });
    const analysisLink = drawer.querySelector('a[href="/app/analysis"]') as HTMLElement;
    analysisLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(analysisLink);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "アプリメニュー" })).toBeNull());

    fireEvent.click(open);
    expect(document.body.style.overflow).toBe("hidden");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024, writable: true });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "アプリメニュー" })).toBeNull());
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "サイドバーを折りたたむ" }));
  });

  it("collapses and expands the desktop sidebar without losing accessible link names", async () => {
    render(createElement(Provider, null, createElement(AppShell, null, createElement("p", null, "main area"))));
    const collapse = screen.getByRole("button", { name: "サイドバーを折りたたむ" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "サイドバーを展開" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".workspace-shell--collapsed")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "動画分析" }).length).toBeGreaterThan(0);
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "サイドバーを折りたたむ" })).toBeTruthy();
  });
});

describe("route workspaces", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("does not create an AI request when the consult route is opened without a current analysis", async () => {
    const fetchMock = installReadOnlyFetch();
    render(createElement(Provider, null, createElement(ConsultView)));
    expect(await screen.findByText("先に動画分析が必要です")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => urlOf(input) === "/api/ai-consult")).toBe(false);
  });

  it("renders every workspace route without navigation-triggered writes or duplicate business GETs", async () => {
    const fetchMock = installReadOnlyFetch();
    const routes = [
      ["ダッシュボード", DashboardView],
      ["動画分析", AnalysisView],
      ["AIコンサル", ConsultView],
      ["改善サイクル", ImprovementsView],
      ["履歴", HistoryView],
      ["プラン・利用状況", PlanView],
      ["設定", SettingsView],
      ["サポート", SupportView],
    ] as const;
    function RouteCatalog() {
      const [index, setIndex] = useState(0);
      const View = routes[index][1];
      return <><button type="button" onClick={() => setIndex((value) => Math.min(value + 1, routes.length - 1))}>next route</button><View /></>;
    }
    render(createElement(Provider, null, createElement(RouteCatalog)));
    for (let index = 0; index < routes.length; index += 1) {
      expect(await screen.findByRole("heading", { level: 1, name: routes[index][0] })).toBeTruthy();
      if (index < routes.length - 1) fireEvent.click(screen.getByRole("button", { name: "next route" }));
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.every(([, init]) => !init || !init.method || init.method === "GET")).toBe(true);
  });

  it("runs one owned-channel analysis and shares the real result without duplicate writes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return response({ items: [], plannedAction: null, nextCursor: null });
      if (url.startsWith("/api/youtube/channel?")) return response({ analysisRunId: "11111111-1111-4111-8111-111111111111", channelId: CHANNEL_ID, channelTitle: "Owner channel", regularVideos: [{ id: "video-1", title: "Real video", publishedAt: "2026-07-27T00:00:00.000Z", thumbnail: "https://example.test/image.jpg", viewCount: "12" }], shortVideos: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(Provider, null, createElement(AnalysisView)));
    const button = await screen.findByRole("button", { name: "動画を分析" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText("Real video")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(1);
  });

  it("keeps the analysis write lock while its route is unmounted and remounted", async () => {
    let resolveAnalysis: ((value: Response) => void) | undefined;
    const pendingAnalysis = new Promise<Response>((resolve) => { resolveAnalysis = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }, { id: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "Second channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return response({ items: [], plannedAction: null, nextCursor: null });
      if (url.startsWith("/api/youtube/channel?")) return pendingAnalysis;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    function RouteHarness() {
      const [route, setRoute] = useState<"analysis" | "away">("analysis");
      return <><button type="button" onClick={() => setRoute(route === "analysis" ? "away" : "analysis")}>route toggle</button>{route === "analysis" ? <AnalysisView /> : <p>other route</p>}</>;
    }

    render(createElement(Provider, null, createElement(RouteHarness)));
    const channelSelect = await screen.findByLabelText("所有チャンネル") as HTMLSelectElement;
    fireEvent.change(channelSelect, { target: { value: CHANNEL_ID } });
    const analyze = await screen.findByRole("button", { name: "動画を分析" });
    await waitFor(() => expect((analyze as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(analyze);
    fireEvent.click(screen.getByRole("button", { name: "route toggle" }));
    expect(await screen.findByText("other route")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "route toggle" }));
    const remounted = await screen.findByRole("button", { name: "分析しています…" });
    expect((remounted as HTMLButtonElement).disabled).toBe(true);
    expect(remounted.getAttribute("aria-busy")).toBe("true");
    const remountedSelect = screen.getByLabelText("所有チャンネル") as HTMLSelectElement;
    expect(remountedSelect.disabled).toBe(true);
    fireEvent.change(remountedSelect, { target: { value: "UCbbbbbbbbbbbbbbbbbbbbbb" } });
    expect(remountedSelect.value).toBe(CHANNEL_ID);
    fireEvent.click(remounted);
    expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/youtube/channel?")).length).toBe(1);
    resolveAnalysis?.(response({ analysisRunId: "11111111-1111-4111-8111-111111111111", channelId: CHANNEL_ID, channelTitle: "Owner channel", regularVideos: [{ id: "video-1", title: "Persisted result", publishedAt: "2026-07-27T00:00:00.000Z", thumbnail: "https://example.test/image.jpg", viewCount: "12" }], shortVideos: [] }));
    expect(await screen.findByText("Persisted result")).toBeTruthy();
  });

  it("keeps the AI consult write lock while its route is unmounted and remounted", async () => {
    let resolveConsult: ((value: Response) => void) | undefined;
    const pendingConsult = new Promise<Response>((resolve) => { resolveConsult = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/usage/status") return response(usage);
      if (url === "/api/youtube/my-channels") return response({ channels: [{ id: CHANNEL_ID, title: "Owner channel" }] });
      if (url === "/api/weekly-cycle?limit=10") return response({ items: [], plannedAction: null, nextCursor: null });
      if (url === "/api/ai-consult") return pendingConsult;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    function SeededConsultHarness() {
      const { setAnalysisResult } = useAppWorkspace();
      const [route, setRoute] = useState<"consult" | "away">("consult");
      useEffect(() => {
        setAnalysisResult({ analysisRunId: "11111111-1111-4111-8111-111111111111", channelId: CHANNEL_ID, channelTitle: "Owner channel", regularVideos: [{ id: "video-1", title: "Source video", publishedAt: "2026-07-27T00:00:00.000Z", thumbnail: "https://example.test/image.jpg", viewCount: "12" }], shortVideos: [] });
      }, [setAnalysisResult]);
      return <><button type="button" onClick={() => setRoute(route === "consult" ? "away" : "consult")}>consult route toggle</button>{route === "consult" ? <ConsultView /> : <p>other consult route</p>}</>;
    }

    render(createElement(Provider, null, createElement(SeededConsultHarness)));
    const consult = await screen.findByRole("button", { name: "AI提案を作成" });
    await waitFor(() => expect((consult as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(consult);
    fireEvent.click(screen.getByRole("button", { name: "consult route toggle" }));
    expect(await screen.findByText("other consult route")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "consult route toggle" }));
    const remounted = await screen.findByRole("button", { name: "提案を作成しています…" });
    expect((remounted as HTMLButtonElement).disabled).toBe(true);
    expect(remounted.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(remounted);
    expect(fetchMock.mock.calls.filter(([input]) => urlOf(input) === "/api/ai-consult").length).toBe(1);
    resolveConsult?.(response({ overallDiagnosis: "Persisted diagnosis", strongPoints: ["Strong"], weakPoints: ["Weak"], currentImprovements: ["Improve"], nextSuggestions: ["Next"] }));
    expect(await screen.findByText("Persisted diagnosis")).toBeTruthy();
  });

  it("seeds improvements from the provider without a second Strict Mode history GET", async () => {
    const fetchMock = installReadOnlyFetch();
    render(createElement(StrictMode, null, createElement(Provider, null, createElement(ImprovementsView))));
    await screen.findByText("今週の改善サイクル");
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => urlOf(input) === "/api/weekly-cycle?limit=10").length).toBe(1));
  });
});
