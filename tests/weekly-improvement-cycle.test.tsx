// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WeeklyImprovementCycle } from "@/app/components/weekly-improvement-cycle";
import type {
  AnalysisHistoryItem,
  ImprovementActionView,
  WeeklyCycleHistoryResponse,
} from "@/app/lib/weekly-cycle-types";

const analysisRunId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const createSuccessMessage = "今週の改善項目を保存しました。";
const createRefreshFailureMessage =
  "改善項目は作成されましたが、最新の履歴を読み込めませんでした。ページを再読み込みして確認してください。";
const updateSuccessMessage = "改善項目を更新しました。";
const updateRefreshFailureMessage =
  "変更は保存されましたが、最新の履歴を読み込めませんでした。ページを再読み込みして確認してください。";

const plannedAction: ImprovementActionView = {
  id: actionId,
  analysisRunId,
  title: "冒頭で結論を伝える",
  description: "最初の15秒で視聴者が得られる価値を伝える。",
  status: "planned",
  resultNote: null,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  completedAt: null,
};

const historyItem: AnalysisHistoryItem = {
  id: analysisRunId,
  channelId: "channel-for-component-test",
  channelTitle: "テストチャンネル",
  analyzedAt: "2026-07-22T00:00:00.000Z",
  regularVideoCount: 3,
  shortVideoCount: 2,
  regularAverageViews: 1200,
  shortAverageViews: 800,
  hasAIConsult: true,
  aiConsultCreatedAt: "2026-07-22T00:00:00.000Z",
  action: plannedAction,
};

const emptyHistory: WeeklyCycleHistoryResponse = {
  items: [],
  plannedAction: null,
  nextCursor: null,
};

const historyWithPlannedAction: WeeklyCycleHistoryResponse = {
  items: [historyItem],
  plannedAction,
  nextCursor: null,
};

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    json: vi.fn(async () => body),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function renderCycle() {
  return render(
    createElement(WeeklyImprovementCycle, {
      currentAnalysisRunId: analysisRunId,
      suggestedAction: "冒頭で結論を伝える",
      refreshKey: 0,
    })
  );
}

function inputUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function callsFor(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  url: string,
  method: "GET" | "POST" | "PATCH"
) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const actualMethod = init?.method?.toUpperCase() ?? "GET";
    return inputUrl(input) === url && actualMethod === method;
  });
}

async function findNotice(message: string, role: "alert" | "status") {
  const title = await screen.findByText(message);
  const panel = title.closest(`[role="${role}"]`);
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

describe("WeeklyImprovementCycle notifications", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows an assertive error when the initial history request rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));

    renderCycle();

    const alert = await findNotice(
      "週次改善サイクルを読み込めませんでした。",
      "alert"
    );
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(screen.queryByText(createSuccessMessage)).toBeNull();
    expect(callsFor(fetchMock, "/api/weekly-cycle?limit=10", "GET")).toHaveLength(1);
  });

  it("shows an error without a success notice when the initial history request is non-200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

    renderCycle();

    const alert = await findNotice(
      "週次改善サイクルの更新に失敗しました。",
      "alert"
    );
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(screen.queryByText(createSuccessMessage)).toBeNull();
    expect(callsFor(fetchMock, "/api/weekly-cycle?limit=10", "GET")).toHaveLength(1);
  });

  it("keeps a create refresh failure instead of overwriting it with success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyHistory))
      .mockResolvedValueOnce(jsonResponse({ action: plannedAction }, 201))
      .mockRejectedValueOnce(new Error("refresh failed"));

    renderCycle();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "今週の改善項目として保存",
      })
    );

    const alert = await findNotice(createRefreshFailureMessage, "alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(screen.queryByText(createSuccessMessage)).toBeNull();
    expect(callsFor(fetchMock, "/api/weekly-cycle/actions", "POST")).toHaveLength(1);
    expect(callsFor(fetchMock, "/api/weekly-cycle?limit=10", "GET")).toHaveLength(2);
  });

  it("keeps an update refresh failure instead of overwriting it with success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction))
      .mockResolvedValueOnce(jsonResponse({ action: plannedAction }))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

    renderCycle();
    const saveButton = await screen.findByRole("button", { name: "内容を保存" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    const alert = await findNotice(updateRefreshFailureMessage, "alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(screen.queryByText(updateSuccessMessage)).toBeNull();
    expect(
      callsFor(
        fetchMock,
        `/api/weekly-cycle/actions/${actionId}`,
        "PATCH"
      )
    ).toHaveLength(1);
    expect(callsFor(fetchMock, "/api/weekly-cycle?limit=10", "GET")).toHaveLength(2);
  });

  it("shows a polite success notice after a normal create and refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyHistory))
      .mockResolvedValueOnce(jsonResponse({ action: plannedAction }, 201))
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction));

    renderCycle();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "今週の改善項目として保存",
      })
    );

    const status = await findNotice(createSuccessMessage, "status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsFor(fetchMock, "/api/weekly-cycle/actions", "POST")).toHaveLength(1);
    expect(callsFor(fetchMock, "/api/weekly-cycle?limit=10", "GET")).toHaveLength(2);
  });

  it("shows success without an error after a normal update and refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction))
      .mockResolvedValueOnce(jsonResponse({ action: plannedAction }))
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction));

    renderCycle();
    const saveButton = await screen.findByRole("button", { name: "内容を保存" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);

    await findNotice(updateSuccessMessage, "status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      callsFor(
        fetchMock,
        `/api/weekly-cycle/actions/${actionId}`,
        "PATCH"
      )
    ).toHaveLength(1);
    expect(callsFor(fetchMock, "/api/weekly-cycle?limit=10", "GET")).toHaveLength(2);
  });

  it("clears an old error at the start of a later successful create", async () => {
    const createRequest = deferred<Response>();
    fetchMock
      .mockRejectedValueOnce(new Error("initial load failed"))
      .mockImplementationOnce(() => createRequest.promise)
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction));

    renderCycle();
    await findNotice("週次改善サイクルを読み込めませんでした。", "alert");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "今週の改善項目として保存",
      })
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    await act(async () => {
      createRequest.resolve(jsonResponse({ action: plannedAction }, 201));
    });

    await findNotice(createSuccessMessage, "status");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears an old success before replacing it with a later refresh error", async () => {
    const updateRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyHistory))
      .mockResolvedValueOnce(jsonResponse({ action: plannedAction }, 201))
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction))
      .mockImplementationOnce(() => updateRequest.promise)
      .mockRejectedValueOnce(new Error("refresh failed"));

    renderCycle();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "今週の改善項目として保存",
      })
    );
    await findNotice(createSuccessMessage, "status");

    const saveButton = await screen.findByRole("button", { name: "内容を保存" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.queryByText(createSuccessMessage)).toBeNull());

    await act(async () => {
      updateRequest.resolve(jsonResponse({ action: plannedAction }));
    });

    await findNotice(updateRefreshFailureMessage, "alert");
    expect(screen.queryByText(createSuccessMessage)).toBeNull();
    expect(screen.queryByText(updateSuccessMessage)).toBeNull();
  });

  it("disables create while pending, ignores a repeated click, and re-enables after resolve", async () => {
    const createRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyHistory))
      .mockImplementationOnce(() => createRequest.promise)
      .mockResolvedValueOnce(jsonResponse(emptyHistory));

    renderCycle();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "今週の改善項目として保存",
      })
    );

    const pendingButton = await screen.findByRole("button", { name: "保存中..." });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pendingButton);
    expect(callsFor(fetchMock, "/api/weekly-cycle/actions", "POST")).toHaveLength(1);

    await act(async () => {
      createRequest.resolve(jsonResponse({ action: plannedAction }, 201));
    });

    await findNotice(createSuccessMessage, "status");
    const enabledButton = await screen.findByRole("button", {
      name: "今週の改善項目として保存",
    });
    expect((enabledButton as HTMLButtonElement).disabled).toBe(false);
    expect(callsFor(fetchMock, "/api/weekly-cycle/actions", "POST")).toHaveLength(1);
  });

  it("disables update while pending, ignores a repeated click, and re-enables after reject", async () => {
    const updateRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(historyWithPlannedAction))
      .mockImplementationOnce(() => updateRequest.promise);

    renderCycle();
    const saveButton = await screen.findByRole("button", { name: "内容を保存" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(saveButton);
    expect(
      callsFor(
        fetchMock,
        `/api/weekly-cycle/actions/${actionId}`,
        "PATCH"
      )
    ).toHaveLength(1);

    await act(async () => {
      updateRequest.reject(new Error("mutation failed"));
    });

    await findNotice("改善項目を更新できませんでした。", "alert");
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    expect(
      callsFor(
        fetchMock,
        `/api/weekly-cycle/actions/${actionId}`,
        "PATCH"
      )
    ).toHaveLength(1);
  });
});
