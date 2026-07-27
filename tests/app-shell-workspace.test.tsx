// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    const remounted = await screen.findByRole("button", { name: "動画を分析" });
    expect((remounted as HTMLButtonElement).disabled).toBe(true);
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
    const remounted = await screen.findByRole("button", { name: "AI提案を作成" });
    expect((remounted as HTMLButtonElement).disabled).toBe(true);
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
