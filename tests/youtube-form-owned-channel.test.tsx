// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YouTubeForm } from "@/app/components/youtube-form";

const CHANNEL_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const ANALYSIS_RUN_ID = "11111111-1111-4111-8111-111111111111";

const emptyHistory = {
  items: [],
  plannedAction: null,
  nextCursor: null,
};

function usageStatus(overrides: {
  analysisDailyRemaining?: number;
  analysisMonthlyRemaining?: number;
  aiDailyRemaining?: number;
  aiMonthlyRemaining?: number;
} = {}) {
  const analysisDailyRemaining = overrides.analysisDailyRemaining ?? 2;
  const analysisMonthlyRemaining = overrides.analysisMonthlyRemaining ?? 5;
  const aiDailyRemaining = overrides.aiDailyRemaining ?? 1;
  const aiMonthlyRemaining = overrides.aiMonthlyRemaining ?? 3;

  return {
    plan: {
      effectivePlanId: "free",
      code: "free",
      kind: "free",
      source: "free_fallback",
      regularVideoLimit: 10,
      shortsVideoLimit: 10,
    },
    usage: {
      channelAnalysis: {
        daily: {
          used: 2 - analysisDailyRemaining,
          limit: 2,
          remaining: analysisDailyRemaining,
          resetAt: "2026-07-25T00:00:00.000Z",
        },
        monthly: {
          used: 5 - analysisMonthlyRemaining,
          limit: 5,
          remaining: analysisMonthlyRemaining,
          resetAt: "2026-08-01T00:00:00.000Z",
        },
      },
      aiConsult: {
        daily: {
          used: 1 - aiDailyRemaining,
          limit: 1,
          remaining: aiDailyRemaining,
          resetAt: "2026-07-25T00:00:00.000Z",
        },
        monthly: {
          used: 3 - aiMonthlyRemaining,
          limit: 3,
          remaining: aiMonthlyRemaining,
          resetAt: "2026-08-01T00:00:00.000Z",
        },
      },
    },
  };
}

function response(body: unknown, status = 200): Response {
  const serialized = JSON.stringify(body);
  return {
    json: vi.fn(async () => body),
    text: vi.fn(async () => serialized),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function inputUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFetchScenario({
  channels = [{ id: CHANNEL_A, title: "Primary channel" }],
  channelsStatus = 200,
  usage = usageStatus(),
  usageStatusCode = 200,
}: {
  channels?: Array<{ id: string; title: string }>;
  channelsStatus?: number;
  usage?: unknown;
  usageStatusCode?: number;
} = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = inputUrl(input);
    if (url === "/api/usage/status") {
      return response(usage, usageStatusCode);
    }
    if (url === "/api/youtube/my-channels") {
      return response({ channels }, channelsStatus);
    }
    if (url === "/api/weekly-cycle?limit=10") {
      return response(emptyHistory);
    }
    if (url.startsWith("/api/youtube/channel?")) {
      return response({
        analysisRunId: ANALYSIS_RUN_ID,
        channelId: CHANNEL_A,
        channelTitle: "Primary channel",
        regularVideos: [],
        shortVideos: [],
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderForm() {
  return render(createElement(YouTubeForm));
}

function analysisButton() {
  return screen.getByRole("button", { name: "分析する" }) as HTMLButtonElement;
}

describe("YouTube form owned-channel and usage preflight", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    const actWarnings = consoleError.mock.calls.filter((call: unknown[]) =>
      call.some((part: unknown) => String(part).includes("not wrapped in act"))
    );
    expect(actWarnings).toEqual([]);
    cleanup();
  });

  it("fails closed when the authenticated user owns no channels", async () => {
    installFetchScenario({ channels: [] });
    renderForm();

    await screen.findByText("分析できる所有チャンネルが見つかりません。");
    expect(analysisButton().disabled).toBe(true);
    expect(document.getElementById("youtube-channel-input")).toBeNull();
  });

  it("auto-selects the only owned channel without arbitrary input", async () => {
    installFetchScenario();
    renderForm();

    await screen.findByText(/選択済み/);
    await waitFor(() => expect(analysisButton().disabled).toBe(false));
    expect(screen.queryByLabelText("所有チャンネルを選択")).toBeNull();
    expect(document.getElementById("youtube-channel-input")).toBeNull();
  });

  it("requires an explicit UI selection when multiple owned channels exist", async () => {
    installFetchScenario({
      channels: [
        { id: CHANNEL_A, title: "Primary channel" },
        { id: CHANNEL_B, title: "Secondary channel" },
      ],
    });
    renderForm();

    const select = (await screen.findByLabelText(
      "所有チャンネルを選択"
    )) as HTMLSelectElement;
    expect(analysisButton().disabled).toBe(true);

    fireEvent.change(select, { target: { value: CHANNEL_A } });

    await waitFor(() => expect(analysisButton().disabled).toBe(false));
    expect(select.value).toBe(CHANNEL_A);
  });

  it("disables analysis and arbitrary fallback when channel loading fails", async () => {
    installFetchScenario({ channelsStatus: 503 });
    renderForm();

    await screen.findByText(
      "所有チャンネルを取得できませんでした。任意入力では分析できません。"
    );
    expect(analysisButton().disabled).toBe(true);
    expect(document.getElementById("youtube-channel-input")).toBeNull();
  });

  it("disables analysis and AI when server usage status is unavailable", async () => {
    installFetchScenario({ usageStatusCode: 500 });
    renderForm();

    await screen.findByText(
      "利用枠を確認できませんでした。安全のため分析とAI提案を停止しています。"
    );
    expect(analysisButton().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "提案を見る" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("disables analysis when either daily or monthly server quota is exhausted", async () => {
    installFetchScenario({
      usage: usageStatus({ analysisMonthlyRemaining: 0 }),
    });
    renderForm();

    await screen.findByText("0 / 5");
    expect(analysisButton().disabled).toBe(true);
  });

  it("submits only the selected owned channel and refreshes status after success", async () => {
    const fetchMock = installFetchScenario();
    renderForm();
    await waitFor(() => expect(analysisButton().disabled).toBe(false));

    fireEvent.click(analysisButton());

    await screen.findByText("Primary channel");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => inputUrl(input) === "/api/usage/status"
        )
      ).toHaveLength(2);
    });
    const analysisCalls = fetchMock.mock.calls.filter(([input]) =>
      inputUrl(input).startsWith("/api/youtube/channel?")
    );
    expect(analysisCalls).toHaveLength(1);
    expect(inputUrl(analysisCalls[0][0])).toBe(
      `/api/youtube/channel?channelId=${CHANNEL_A}`
    );
    expect(JSON.stringify(analysisCalls[0])).not.toMatch(
      /(?:userId|ownerId|plan|quota|dailyLimit|monthlyLimit)/
    );
  });

  it("keeps the preflight layout bounded at 1024px and collapsed for 320px", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8"
    );
    const desktopRule = css.match(
      /\.youtube-preflight-grid\s*\{([\s\S]*?)\}/
    )?.[1];
    const tabletRules = css.slice(
      css.indexOf("@media (max-width: 900px)"),
      css.indexOf("@media (max-width: 768px)")
    );
    const mobileRules = css.slice(
      css.indexOf("@media (max-width: 640px)"),
      css.indexOf("@media (max-width: 390px)")
    );
    const narrowRules = css.slice(
      css.indexOf("@media (max-width: 390px)"),
      css.indexOf("@media (max-width: 1199px)")
    );

    expect(desktopRule).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))"
    );
    expect(css).toMatch(/\.youtube-preflight-card\s*\{[\s\S]*?min-width: 0/);
    expect(tabletRules).toMatch(
      /\.youtube-preflight-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/
    );
    expect(mobileRules).toMatch(
      /\.youtube-quota-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/
    );
    expect(mobileRules).toMatch(
      /\.youtube-input-bar > button,[\s\S]*?width: 100%/
    );
    expect(narrowRules).toMatch(
      /\.page-container\s*\{[\s\S]*?padding-inline: 12px/
    );
  });
});
