import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INTERNAL_USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";
const RESERVATION_ID = "a95fa157-5f30-42ca-97ea-d7ba4f23f331";
const ANALYSIS_RUN_ID = "3ecce3e0-2dd5-4b57-9a4a-f26b4c7793b3";

const authState = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; name: string; email: string };
    expires: string;
  },
}));

const jwtState = vi.hoisted(() => ({
  token: null as null | {
    sub: string;
    internalUserId?: string;
    sessionVersion?: number;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
  },
}));

const openAIState = vi.hoisted(() => ({ create: vi.fn() }));
const usageState = vi.hoisted(() => ({
  reserve: vi.fn(),
  release: vi.fn(),
  finalize: vi.fn(),
}));
const staleRecoveryState = vi.hoisted(() => ({ recover: vi.fn() }));
const weeklyCycleState = vi.hoisted(() => ({
  finalizeChannel: vi.fn(),
  finalizeAI: vi.fn(),
  analysisBelongs: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  identityValid: vi.fn(),
}));
const weeklyCycleErrors = vi.hoisted(() => ({
  NotFound: class WeeklyCycleNotFoundError extends Error {},
  ActionAlreadyExists: class WeeklyCycleActionAlreadyExistsError extends Error {},
  Conflict: class WeeklyCycleConflictError extends Error {},
  Persistence: class WeeklyCyclePersistenceError extends Error {},
}));

vi.mock("@/auth", () => ({
  auth: vi.fn((handler?: (request: Request & { auth: unknown }) => unknown) => {
    if (typeof handler !== "function") return Promise.resolve(authState.session);

    return async (request: Request) => {
      Object.defineProperty(request, "auth", {
        configurable: true,
        value: authState.session,
      });
      return handler(request as Request & { auth: unknown });
    };
  }),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => jwtState.token),
}));

vi.mock("@/db/usage-limits", () => ({
  reserveUsage: usageState.reserve,
  releaseUsageReservation: usageState.release,
  finalizeUsageReservation: usageState.finalize,
}));

vi.mock("@/app/lib/stale-reservation-recovery", () => ({
  OPPORTUNISTIC_RECOVERY_BATCH_SIZE: 25,
  recoverExpiredUsageReservations: staleRecoveryState.recover,
}));

vi.mock("@/db/weekly-cycle", () => ({
  finalizeChannelAnalysis: weeklyCycleState.finalizeChannel,
  finalizeAIConsult: weeklyCycleState.finalizeAI,
  analysisRunBelongsToUser: weeklyCycleState.analysisBelongs,
  listWeeklyCycles: weeklyCycleState.list,
  createImprovementAction: weeklyCycleState.create,
  updateImprovementAction: weeklyCycleState.update,
  weeklyCycleIdentityIsValid: weeklyCycleState.identityValid,
  decodeHistoryCursor: vi.fn(() => null),
  WeeklyCycleNotFoundError: weeklyCycleErrors.NotFound,
  WeeklyCycleActionAlreadyExistsError: weeklyCycleErrors.ActionAlreadyExists,
  WeeklyCycleConflictError: weeklyCycleErrors.Conflict,
  WeeklyCyclePersistenceError: weeklyCycleErrors.Persistence,
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: openAIState.create };
  },
}));

type RouteHandler = (request: NextRequest) => Promise<Response>;

let aiConsultPost: RouteHandler;
let analyzePost: RouteHandler;
let youtubeChannelGet: RouteHandler;
let myChannelsGet: RouteHandler;
let myChannelVideosGet: RouteHandler;
let weeklyCycleGet: RouteHandler;
let weeklyActionPost: RouteHandler;
let weeklyActionPatch: (
  request: NextRequest,
  context: { params: Promise<{ actionId: string }> }
) => Promise<Response>;

const originalYouTubeApiKey = process.env.YOUTUBE_API_KEY;

function jsonRequest(url: string, body: unknown, headers: HeadersInit = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: "authjs.session-token=test-session-cookie",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authenticatedGet(url: string) {
  return new NextRequest(url, {
    headers: { cookie: "authjs.session-token=test-session-cookie" },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validAISummary() {
  const section = {
    count: 0,
    averageViews: 0,
    postingFrequency: "No recent videos",
    topVideo: null,
    lowVideo: null,
    videos: [],
  };

  return {
    channelTitle: "Test Channel",
    regular: section,
    shorts: { ...section },
  };
}

function successfulConsultOutput() {
  return JSON.stringify({
    overallDiagnosis: "Test diagnosis",
    strongPoints: ["Test strength"],
    weakPoints: ["Test weakness"],
    currentImprovements: ["Test improvement"],
    nextSuggestions: ["Test suggestion"],
  });
}

function allowedReservation(metric: "channel_analysis" | "ai_consult") {
  return {
    allowed: true as const,
    denialReason: null,
    reservationId: RESERVATION_ID,
    metric,
    dailyUsed: 1,
    dailyLimit: metric === "channel_analysis" ? 2 : 1,
    dailyResetAt: new Date("2026-07-19T00:00:00.000Z"),
    monthlyUsed: 1,
    monthlyLimit: metric === "channel_analysis" ? 5 : 3,
    monthlyResetAt: new Date("2026-08-01T00:00:00.000Z"),
    planCode: "free",
  };
}

function installChannelFetchMock() {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input));
    const part = url.searchParams.get("part");

    if (url.pathname.endsWith("/channels") && part?.includes("contentDetails")) {
      return jsonResponse({
        items: [
          {
            contentDetails: { relatedPlaylists: { uploads: "UUtestuploads" } },
            snippet: { title: "Test Channel", description: "Test" },
            statistics: {
              subscriberCount: "1",
              videoCount: "0",
              viewCount: "1",
            },
          },
        ],
      });
    }

    if (url.pathname.endsWith("/playlistItems")) {
      return jsonResponse({ items: [] });
    }

    throw new Error("Unexpected mocked fetch target.");
  });
}

function channelRequest(extraQuery = "") {
  const channelUrl = encodeURIComponent(
    "https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"
  );
  return authenticatedGet(
    `http://localhost/api/youtube/channel?url=${channelUrl}${extraQuery}`
  );
}

beforeAll(async () => {
  process.env.YOUTUBE_API_KEY = "test-youtube-api-key";

  const [
    aiConsultRoute,
    analyzeRoute,
    youtubeChannelRoute,
    myChannelsRoute,
    myChannelVideosRoute,
    weeklyCycleRoute,
    weeklyActionRoute,
    weeklyActionUpdateRoute,
  ] = await Promise.all([
    import("@/app/api/ai-consult/route"),
    import("@/app/api/analyze/route"),
    import("@/app/api/youtube/channel/route"),
    import("@/app/api/youtube/my-channels/route"),
    import("@/app/api/youtube/my-channels/videos/route"),
    import("@/app/api/weekly-cycle/route"),
    import("@/app/api/weekly-cycle/actions/route"),
    import("@/app/api/weekly-cycle/actions/[actionId]/route"),
  ]);

  aiConsultPost = aiConsultRoute.POST;
  analyzePost = analyzeRoute.POST;
  youtubeChannelGet = youtubeChannelRoute.GET;
  myChannelsGet = myChannelsRoute.GET as unknown as RouteHandler;
  myChannelVideosGet = myChannelVideosRoute.GET as unknown as RouteHandler;
  weeklyCycleGet = weeklyCycleRoute.GET;
  weeklyActionPost = weeklyActionRoute.POST;
  weeklyActionPatch = weeklyActionUpdateRoute.PATCH;
});

afterAll(() => {
  if (originalYouTubeApiKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = originalYouTubeApiKey;
});

beforeEach(() => {
  authState.session = {
    user: {
      id: INTERNAL_USER_ID,
      name: "Test User",
      email: "user@example.test",
    },
    expires: "2099-01-01T00:00:00.000Z",
  };
  jwtState.token = {
    sub: "authjs-subject-not-internal-user-id",
    internalUserId: INTERNAL_USER_ID,
    sessionVersion: 7,
    accessToken: "test-google-access-token",
    refreshToken: "test-google-refresh-token",
    accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  };
  vi.stubEnv("AUTH_SECRET", "test-auth-secret");
  vi.stubEnv("YOUTUBE_API_KEY", "test-youtube-api-key");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-api-key");
  openAIState.create.mockRejectedValue(
    new Error("Unexpected OpenAI SDK request blocked by tests.")
  );
  usageState.reserve.mockImplementation(async ({ metric }) =>
    allowedReservation(metric)
  );
  usageState.release.mockResolvedValue({
    released: true,
    dailyUsed: 0,
    monthlyUsed: 0,
  });
  usageState.finalize.mockResolvedValue(true);
  staleRecoveryState.recover.mockResolvedValue({ recovered: 0 });
  weeklyCycleState.finalizeChannel.mockResolvedValue(ANALYSIS_RUN_ID);
  weeklyCycleState.finalizeAI.mockResolvedValue(true);
  weeklyCycleState.analysisBelongs.mockResolvedValue(true);
  weeklyCycleState.list.mockResolvedValue({
    items: [],
    plannedAction: null,
    nextCursor: null,
  });
  weeklyCycleState.create.mockResolvedValue({
    id: "267c7d5d-d722-4a64-bcf2-13058333109c",
    analysisRunId: ANALYSIS_RUN_ID,
    title: "Improve the opening",
    description: "Show the result first",
    status: "planned",
    resultNote: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    completedAt: null,
  });
  weeklyCycleState.update.mockResolvedValue({
    id: "267c7d5d-d722-4a64-bcf2-13058333109c",
    analysisRunId: ANALYSIS_RUN_ID,
    title: "Improve the opening",
    description: "Show the result first",
    status: "completed",
    resultNote: "Retention improved",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:00.000Z",
  });
  weeklyCycleState.identityValid.mockResolvedValue(true);
});

describe("API authentication and retired route", () => {
  it.each([
    {
      route: "POST /api/ai-consult",
      invoke: () =>
        aiConsultPost(
          jsonRequest("http://localhost/api/ai-consult", {
            aiSummary: validAISummary(),
          })
        ),
    },
    { route: "GET /api/youtube/channel", invoke: () => youtubeChannelGet(channelRequest()) },
    {
      route: "GET /api/youtube/my-channels",
      invoke: () =>
        myChannelsGet(authenticatedGet("http://localhost/api/youtube/my-channels")),
    },
    {
      route: "GET /api/youtube/my-channels/videos",
      invoke: () =>
        myChannelVideosGet(
          authenticatedGet(
            "http://localhost/api/youtube/my-channels/videos?channelId=UCaaaaaaaaaaaaaaaaaaaaaa"
          )
        ),
    },
  ])("returns 401 before DB or external work for $route", async ({ invoke }) => {
    authState.session = null;

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(usageState.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(openAIState.create).not.toHaveBeenCalled();
  });

  it("returns 410 from the unused legacy /api/analyze route", async () => {
    authState.session = null;

    const response = await analyzePost(
      jsonRequest("http://localhost/api/analyze", { userId: INTERNAL_USER_ID })
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "This endpoint is no longer available.",
      code: "ENDPOINT_GONE",
    });
    expect(usageState.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(openAIState.create).not.toHaveBeenCalled();
  });
});

describe("weekly improvement cycle APIs", () => {
  it.each([
    {
      name: "history",
      invoke: () => weeklyCycleGet(authenticatedGet("http://localhost/api/weekly-cycle")),
    },
    {
      name: "action creation",
      invoke: () =>
        weeklyActionPost(
          jsonRequest("http://localhost/api/weekly-cycle/actions", {
            analysisRunId: ANALYSIS_RUN_ID,
            title: "Improve the opening",
            description: "Show the result first",
          })
        ),
    },
    {
      name: "action update",
      invoke: () =>
        weeklyActionPatch(
          jsonRequest(
            "http://localhost/api/weekly-cycle/actions/267c7d5d-d722-4a64-bcf2-13058333109c",
            { status: "completed", resultNote: "Retention improved" }
          ),
          {
            params: Promise.resolve({
              actionId: "267c7d5d-d722-4a64-bcf2-13058333109c",
            }),
          }
        ),
    },
  ])("returns 401 for unauthenticated $name", async ({ invoke }) => {
    authState.session = null;
    const response = await invoke();
    expect(response.status).toBe(401);
    expect(weeklyCycleState.list).not.toHaveBeenCalled();
    expect(weeklyCycleState.create).not.toHaveBeenCalled();
    expect(weeklyCycleState.update).not.toHaveBeenCalled();
  });

  it("uses only the authenticated internal user ID for history and action writes", async () => {
    await weeklyCycleGet(authenticatedGet("http://localhost/api/weekly-cycle?limit=10"));
    await weeklyActionPost(
      jsonRequest("http://localhost/api/weekly-cycle/actions", {
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Improve the opening",
        description: "Show the result first",
        userId: "attacker",
      })
    );
    await weeklyActionPatch(
      jsonRequest(
        "http://localhost/api/weekly-cycle/actions/267c7d5d-d722-4a64-bcf2-13058333109c",
        { status: "completed", resultNote: "Retention improved", userId: "attacker" }
      ),
      {
        params: Promise.resolve({
          actionId: "267c7d5d-d722-4a64-bcf2-13058333109c",
        }),
      }
    );

    expect(weeklyCycleState.list).toHaveBeenCalledWith(
      expect.objectContaining({ userId: INTERNAL_USER_ID, limit: 10 })
    );
    expect(weeklyCycleState.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: INTERNAL_USER_ID, analysisRunId: ANALYSIS_RUN_ID })
    );
    expect(weeklyCycleState.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: INTERNAL_USER_ID, status: "completed" })
    );
  });

  it("rejects a stale or inactive persisted identity", async () => {
    weeklyCycleState.identityValid.mockResolvedValueOnce(false);
    const response = await weeklyCycleGet(
      authenticatedGet("http://localhost/api/weekly-cycle")
    );

    expect(response.status).toBe(401);
    expect(weeklyCycleState.list).not.toHaveBeenCalled();
  });

  it("returns 404 when an analysis or action is not owned by the user", async () => {
    weeklyCycleState.create.mockRejectedValueOnce(new weeklyCycleErrors.NotFound());
    const createResponse = await weeklyActionPost(
      jsonRequest("http://localhost/api/weekly-cycle/actions", {
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Other user's analysis",
        description: "",
      })
    );

    weeklyCycleState.update.mockRejectedValueOnce(new weeklyCycleErrors.NotFound());
    const updateResponse = await weeklyActionPatch(
      jsonRequest(
        "http://localhost/api/weekly-cycle/actions/267c7d5d-d722-4a64-bcf2-13058333109c",
        { status: "skipped", resultNote: "Not applicable" }
      ),
      {
        params: Promise.resolve({
          actionId: "267c7d5d-d722-4a64-bcf2-13058333109c",
        }),
      }
    );

    expect(createResponse.status).toBe(404);
    expect(updateResponse.status).toBe(404);
  });

  it("rejects invalid status and reports planned-action conflicts", async () => {
    const invalid = await weeklyActionPatch(
      jsonRequest(
        "http://localhost/api/weekly-cycle/actions/267c7d5d-d722-4a64-bcf2-13058333109c",
        { status: "invalid", resultNote: "x" }
      ),
      {
        params: Promise.resolve({
          actionId: "267c7d5d-d722-4a64-bcf2-13058333109c",
        }),
      }
    );
    expect(invalid.status).toBe(400);
    expect(weeklyCycleState.update).not.toHaveBeenCalled();

    weeklyCycleState.create.mockRejectedValueOnce(new weeklyCycleErrors.Conflict());
    const conflict = await weeklyActionPost(
      jsonRequest("http://localhost/api/weekly-cycle/actions", {
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Second planned action",
        description: "",
      })
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "PLANNED_ACTION_EXISTS" });
  });

  it("returns the dedicated 409 response for an existing analysis action", async () => {
    weeklyCycleState.create.mockRejectedValueOnce(
      new weeklyCycleErrors.ActionAlreadyExists()
    );

    const response = await weeklyActionPost(
      jsonRequest("http://localhost/api/weekly-cycle/actions", {
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Duplicate action",
        description: "",
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "この分析にはすでに改善項目があります。",
      code: "IMPROVEMENT_ACTION_ALREADY_EXISTS",
    });
  });
});

describe("validation occurs before usage reservation", () => {
  it("rejects invalid AI consultation input without consuming usage", async () => {
    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", { aiSummary: {} })
    );

    expect(response.status).toBe(400);
    expect(usageState.reserve).not.toHaveBeenCalled();
    expect(openAIState.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid channel URL without consuming usage", async () => {
    const response = await youtubeChannelGet(
      authenticatedGet(
        "http://localhost/api/youtube/channel?url=https%3A%2F%2Fexample.com%2Fchannel"
      )
    );

    expect(response.status).toBe(400);
    expect(usageState.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves my-channels/videos input validation and authentication", async () => {
    const response = await myChannelVideosGet(
      authenticatedGet(
        "http://localhost/api/youtube/my-channels/videos?channelId=invalid"
      )
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("successful usage reservations", () => {
  it("reserves channel_analysis, finalizes it, and returns additive usage", async () => {
    installChannelFetchMock();

    const response = await youtubeChannelGet(
      channelRequest("&plan=paid&userId=attacker&limit=999999")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(usageState.reserve).toHaveBeenCalledWith({
      userId: INTERNAL_USER_ID,
      sessionVersion: 7,
      metric: "channel_analysis",
    });
    expect(staleRecoveryState.recover).toHaveBeenCalledWith(25);
    expect(weeklyCycleState.finalizeChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: RESERVATION_ID,
        userId: INTERNAL_USER_ID,
        snapshot: expect.objectContaining({
          channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
          channelTitle: "Test Channel",
        }),
      })
    );
    expect(usageState.finalize).not.toHaveBeenCalled();
    expect(usageState.release).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body.plan).toBe("free");
    expect(body.analysisRunId).toBe(ANALYSIS_RUN_ID);
    expect(body.usage).toEqual({
      metric: "channel_analysis",
      planCode: "free",
      dailyUsed: 1,
      dailyLimit: 2,
      dailyResetAt: "2026-07-19T00:00:00.000Z",
      monthlyUsed: 1,
      monthlyLimit: 5,
      monthlyResetAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reserves ai_consult and ignores client-owned identity and limit fields", async () => {
    openAIState.create.mockResolvedValue({ output_text: successfulConsultOutput() });

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
        analysisRunId: ANALYSIS_RUN_ID,
        userId: "attacker",
        plan: "paid",
        limit: 999_999,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(usageState.reserve).toHaveBeenCalledWith({
      userId: INTERNAL_USER_ID,
      sessionVersion: 7,
      metric: "ai_consult",
    });
    expect(weeklyCycleState.analysisBelongs).toHaveBeenCalledWith(
      INTERNAL_USER_ID,
      ANALYSIS_RUN_ID
    );
    expect(weeklyCycleState.finalizeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: RESERVATION_ID,
        userId: INTERNAL_USER_ID,
        analysisRunId: ANALYSIS_RUN_ID,
      })
    );
    expect(usageState.finalize).not.toHaveBeenCalled();
    expect(usageState.release).not.toHaveBeenCalled();
    expect(openAIState.create).toHaveBeenCalledTimes(1);
    expect(body.overallDiagnosis).toBe("Test diagnosis");
    expect(body.usage.metric).toBe("ai_consult");
    expect(body.usage.dailyLimit).toBe(1);
    expect(body.usage.monthlyLimit).toBe(3);
  });

  it("continues normal usage when opportunistic recovery fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    staleRecoveryState.recover.mockRejectedValue(
      new Error("postgresql://user:secret@example.test/database")
    );
    installChannelFetchMock();

    const response = await youtubeChannelGet(channelRequest());

    expect(response.status).toBe(200);
    expect(usageState.reserve).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "usage-reservation-opportunistic-recovery failed",
      { errorName: "Error" }
    );
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret@example"
    );
  });
});

describe("usage denial HTTP mapping", () => {
  it.each([
    ["user_not_found", 401, "REAUTHENTICATION_REQUIRED"],
    ["session_version_mismatch", 401, "REAUTHENTICATION_REQUIRED"],
    ["user_inactive", 403, "ACCOUNT_UNAVAILABLE"],
    ["no_active_plan", 403, "NO_ACTIVE_PLAN"],
  ] as const)("maps %s safely", async (denialReason, status, code) => {
    usageState.reserve.mockResolvedValue({
      allowed: false,
      denialReason,
      reservationId: null,
      metric: "channel_analysis",
      dailyUsed: null,
      dailyLimit: null,
      dailyResetAt: new Date("2026-07-19T00:00:00.000Z"),
      monthlyUsed: null,
      monthlyLimit: null,
      monthlyResetAt: new Date("2026-08-01T00:00:00.000Z"),
      planCode: null,
    });

    const response = await youtubeChannelGet(channelRequest());
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["daily_limit_reached", "DAILY_USAGE_LIMIT_REACHED", "3600"],
    ["monthly_limit_reached", "MONTHLY_USAGE_LIMIT_REACHED", "1126800"],
  ] as const)(
    "returns 429 usage details and Retry-After for %s",
    async (denialReason, code, retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-18T23:00:00.000Z"));
      usageState.reserve.mockResolvedValue({
        allowed: false,
        denialReason,
        reservationId: null,
        metric: "channel_analysis",
        dailyUsed: 2,
        dailyLimit: 2,
        dailyResetAt: new Date("2026-07-19T00:00:00.000Z"),
        monthlyUsed: 5,
        monthlyLimit: 5,
        monthlyResetAt: new Date("2026-08-01T00:00:00.000Z"),
        planCode: "free",
      });

      const response = await youtubeChannelGet(channelRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
      expect(body).toMatchObject({
        code,
        metric: "channel_analysis",
        dailyUsed: 2,
        dailyLimit: 2,
        dailyResetAt: "2026-07-19T00:00:00.000Z",
        monthlyUsed: 5,
        monthlyLimit: 5,
        monthlyResetAt: "2026-08-01T00:00:00.000Z",
        planCode: "free",
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("requires reauthentication when JWT sessionVersion is absent", async () => {
    if (jwtState.token) jwtState.token.sessionVersion = undefined;

    const response = await youtubeChannelGet(channelRequest());

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("REAUTHENTICATION_REQUIRED");
    expect(usageState.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("external failures release usage", () => {
  it.each([
    ["service failure", new Error("raw youtube secret"), 502],
    [
      "timeout",
      Object.assign(new Error("raw youtube timeout secret"), {
        name: "TimeoutError",
      }),
      504,
    ],
  ] as const)("releases a YouTube reservation on %s", async (_label, error, status) => {
    vi.mocked(fetch).mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await youtubeChannelGet(channelRequest());
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(status);
    expect(usageState.release).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      userId: INTERNAL_USER_ID,
    });
    expect(usageState.finalize).not.toHaveBeenCalled();
    expect(weeklyCycleState.finalizeChannel).not.toHaveBeenCalled();
    expect(serialized).not.toContain("secret");
  });

  it.each([
    ["service failure", new Error("raw OpenAI secret"), 502],
    [
      "timeout",
      Object.assign(new Error("raw OpenAI timeout secret"), {
        name: "APIConnectionTimeoutError",
      }),
      504,
    ],
  ] as const)("releases an OpenAI reservation on %s", async (_label, error, status) => {
    openAIState.create.mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
        analysisRunId: ANALYSIS_RUN_ID,
      })
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(status);
    expect(usageState.release).toHaveBeenCalledTimes(1);
    expect(usageState.finalize).not.toHaveBeenCalled();
    expect(weeklyCycleState.finalizeAI).not.toHaveBeenCalled();
    expect(serialized).not.toContain("secret");
  });

  it("does not expose a release database failure", async () => {
    openAIState.create.mockRejectedValueOnce(new Error("external secret"));
    usageState.release.mockRejectedValueOnce(
      new Error("postgresql://user:database-secret@example.test/database")
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
        analysisRunId: ANALYSIS_RUN_ID,
      })
    );
    const body = JSON.stringify(await response.json());
    const logs = JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(502);
    expect(body).not.toContain("database-secret");
    expect(logs).not.toContain("database-secret");
    expect(logs).not.toContain("postgresql://");
  });

  it("does not expose a reservation database failure", async () => {
    usageState.reserve.mockRejectedValueOnce(
      new Error("postgresql://user:database-secret@example.test/database")
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await youtubeChannelGet(channelRequest());
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(body).toBe(JSON.stringify({ error: "An internal server error occurred." }));
    expect(body).not.toContain("database-secret");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing or other-user analysis before AI usage or external work", async () => {
    weeklyCycleState.analysisBelongs.mockResolvedValueOnce(false);

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
        analysisRunId: ANALYSIS_RUN_ID,
      })
    );

    expect(response.status).toBe(404);
    expect(usageState.reserve).not.toHaveBeenCalled();
    expect(openAIState.create).not.toHaveBeenCalled();
    expect(weeklyCycleState.finalizeAI).not.toHaveBeenCalled();
  });

  it("releases usage when atomic history finalization fails", async () => {
    installChannelFetchMock();
    weeklyCycleState.finalizeChannel.mockRejectedValueOnce(
      new Error("postgresql://user:database-secret@example.test/database")
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await youtubeChannelGet(channelRequest());
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(usageState.release).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      userId: INTERNAL_USER_ID,
    });
    expect(body).not.toContain("database-secret");
  });
});

describe("existing Google OAuth route behavior", () => {
  it("uses OAuth when internalUserId matches even if token.sub differs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: "UCaaaaaaaaaaaaaaaaaaaaaa",
            snippet: { title: "Test Channel", description: "Test" },
          },
        ],
      })
    );

    const response = await myChannelsGet(
      authenticatedGet("http://localhost/api/youtube/my-channels")
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects OAuth when internalUserId differs from the session user", async () => {
    if (jwtState.token) {
      jwtState.token.sub = INTERNAL_USER_ID;
      jwtState.token.internalUserId = "2f5e100f-f94d-4b36-a3e4-a6f41a722d1d";
    }

    const response = await myChannelsGet(
      authenticatedGet("http://localhost/api/youtube/my-channels")
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to token.sub when internalUserId is missing", async () => {
    if (jwtState.token) {
      jwtState.token.sub = INTERNAL_USER_ID;
      jwtState.token.internalUserId = undefined;
    }

    const response = await myChannelsGet(
      authenticatedGet("http://localhost/api/youtube/my-channels")
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves authenticated my-channels/videos success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ items: [] }));

    const response = await myChannelVideosGet(
      authenticatedGet(
        "http://localhost/api/youtube/my-channels/videos?channelId=UCaaaaaaaaaaaaaaaaaaaaaa"
      )
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
