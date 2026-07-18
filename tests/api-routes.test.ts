import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
  },
}));

const openAIState = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn((handler?: (request: Request & { auth: unknown }) => unknown) => {
    if (typeof handler !== "function") {
      return Promise.resolve(authState.session);
    }

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

const originalYouTubeApiKey = process.env.YOUTUBE_API_KEY;

function jsonRequest(url: string, body: unknown, headers: HeadersInit = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
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

function installAnalyzeFetchMock() {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/search")) {
      return jsonResponse({ items: [] });
    }

    if (url.hostname === "api.openai.com") {
      return jsonResponse({
        choices: [{ message: { content: "Test analysis report" } }],
      });
    }

    throw new Error("Unexpected mocked fetch target.");
  });
}

beforeAll(async () => {
  process.env.YOUTUBE_API_KEY = "test-youtube-api-key";

  const [
    aiConsultRoute,
    analyzeRoute,
    youtubeChannelRoute,
    myChannelsRoute,
    myChannelVideosRoute,
  ] = await Promise.all([
    import("@/app/api/ai-consult/route"),
    import("@/app/api/analyze/route"),
    import("@/app/api/youtube/channel/route"),
    import("@/app/api/youtube/my-channels/route"),
    import("@/app/api/youtube/my-channels/videos/route"),
  ]);

  aiConsultPost = aiConsultRoute.POST;
  analyzePost = analyzeRoute.POST;
  youtubeChannelGet = youtubeChannelRoute.GET;
  myChannelsGet = myChannelsRoute.GET as unknown as RouteHandler;
  myChannelVideosGet = myChannelVideosRoute.GET as unknown as RouteHandler;
});

afterAll(() => {
  if (originalYouTubeApiKey === undefined) {
    delete process.env.YOUTUBE_API_KEY;
  } else {
    process.env.YOUTUBE_API_KEY = originalYouTubeApiKey;
  }
});

beforeEach(() => {
  authState.session = {
    user: {
      id: "test-user-id",
      name: "Test User",
      email: "user@example.test",
    },
    expires: "2099-01-01T00:00:00.000Z",
  };
  jwtState.token = {
    sub: "authjs-subject-not-internal-user-id",
    internalUserId: "test-user-id",
    accessToken: "test-google-access-token",
    refreshToken: "test-google-refresh-token",
    accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  };
  vi.stubEnv("AUTH_SECRET", "test-auth-secret");
  vi.stubEnv("YOUTUBE_API_KEY", "test-youtube-api-key");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-api-key");
  openAIState.create.mockReset();
  openAIState.create.mockRejectedValue(
    new Error("Unexpected OpenAI SDK request blocked by tests.")
  );
});

describe("API authentication", () => {
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
    {
      route: "POST /api/analyze",
      invoke: () =>
        analyzePost(
          jsonRequest("http://localhost/api/analyze", {
            mode: "manual_url",
            url: "https://www.youtube.com/@YouTube",
          })
        ),
    },
    {
      route: "GET /api/youtube/channel",
      invoke: () =>
        youtubeChannelGet(
          new NextRequest(
            "http://localhost/api/youtube/channel?url=https%3A%2F%2Fwww.youtube.com%2F%40YouTube"
          )
        ),
    },
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
  ])("returns 401 before external work for $route", async ({ invoke }) => {
    authState.session = null;

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
    expect(fetch).not.toHaveBeenCalled();
    expect(openAIState.create).not.toHaveBeenCalled();
  });
});

describe("API input validation", () => {
  it("returns 400 for invalid AI consultation input", async () => {
    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", { aiSummary: {} })
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(openAIState.create).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid analysis input", async () => {
    const response = await analyzePost(
      jsonRequest("http://localhost/api/analyze", { mode: "untrusted" })
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid channel URL", async () => {
    const response = await youtubeChannelGet(
      new NextRequest(
        "http://localhost/api/youtube/channel?url=https%3A%2F%2Fexample.com%2Fchannel"
      )
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid channel ID", async () => {
    const response = await myChannelVideosGet(
      authenticatedGet(
        "http://localhost/api/youtube/my-channels/videos?channelId=invalid"
      )
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 for an oversized JSON body", async () => {
    const response = await analyzePost(
      jsonRequest("http://localhost/api/analyze", {
        mode: "manual_url",
        url: `https://www.youtube.com/@${"a".repeat(9_000)}`,
      })
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON Content-Type", async () => {
    const response = await analyzePost(
      new NextRequest("http://localhost/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      })
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("authenticated API success responses", () => {
  it("returns 200 from POST /api/ai-consult with a mocked OpenAI response", async () => {
    openAIState.create.mockResolvedValue({
      output_text: successfulConsultOutput(),
    });

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
      })
    );

    expect(response.status).toBe(200);
    expect(openAIState.create).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 200 from POST /api/analyze with mocked YouTube and OpenAI responses", async () => {
    installAnalyzeFetchMock();

    const response = await analyzePost(
      jsonRequest("http://localhost/api/analyze", {
        mode: "my_channel",
        channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      })
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns 200 from GET /api/youtube/channel with mocked YouTube responses", async () => {
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

    const channelUrl = encodeURIComponent(
      "https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"
    );
    const response = await youtubeChannelGet(
      new NextRequest(`http://localhost/api/youtube/channel?url=${channelUrl}`)
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

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

  it("rejects an OAuth JWT whose internal user ID differs from the session user", async () => {
    if (jwtState.token) {
      jwtState.token.sub = "test-user-id";
      jwtState.token.internalUserId = "different-internal-user-id";
    }

    const response = await myChannelsGet(
      authenticatedGet("http://localhost/api/youtube/my-channels")
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "YouTube authorization is required.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to token.sub when the internal user ID is missing", async () => {
    if (jwtState.token) {
      jwtState.token.sub = "test-user-id";
      jwtState.token.internalUserId = undefined;
    }

    const response = await myChannelsGet(
      authenticatedGet("http://localhost/api/youtube/my-channels")
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "YouTube authorization is required.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 200 from GET /api/youtube/my-channels/videos with a mocked OAuth response", async () => {
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

describe("safe external service failures", () => {
  it("returns 504 for a mocked fetch timeout", async () => {
    const timeout = new Error("test-youtube-api-key must not escape");
    timeout.name = "TimeoutError";
    vi.mocked(fetch).mockRejectedValueOnce(timeout);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await analyzePost(
      jsonRequest("http://localhost/api/analyze", {
        mode: "my_channel",
        channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      })
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(504);
    expect(body).toBe(JSON.stringify({ error: "The external service timed out." }));
    expect(body).not.toContain("test-youtube-api-key");
    expect(body).not.toContain("stack");
  });

  it("returns 504 for a mocked OpenAI SDK timeout", async () => {
    const timeout = new Error("test-openai-api-key must not escape");
    timeout.name = "APIConnectionTimeoutError";
    openAIState.create.mockRejectedValueOnce(timeout);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
      })
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(504);
    expect(body).not.toContain("test-openai-api-key");
    expect(body).not.toContain("stack");
  });

  it("sanitizes mocked external API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          error: "raw external error",
          access_token: "test-google-access-token",
          stack: "raw stack trace",
        },
        500
      )
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await analyzePost(
      jsonRequest("http://localhost/api/analyze", {
        mode: "my_channel",
        channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      })
    );
    const body = JSON.stringify(await response.json());
    const logged = JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(502);
    expect(body).toBe(
      JSON.stringify({ error: "The external service request failed." })
    );
    for (const secret of [
      "test-google-access-token",
      "test-google-refresh-token",
      "test-youtube-api-key",
      "test-openai-api-key",
      "raw external error",
      "raw stack trace",
    ]) {
      expect(body).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(body).not.toContain("stack");
  });

  it("sanitizes mocked OpenAI SDK errors", async () => {
    openAIState.create.mockRejectedValueOnce(
      new Error("test-openai-api-key and raw SDK response must not escape")
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await aiConsultPost(
      jsonRequest("http://localhost/api/ai-consult", {
        aiSummary: validAISummary(),
      })
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(body).toBe(
      JSON.stringify({ error: "The external service request failed." })
    );
    expect(body).not.toContain("test-openai-api-key");
    expect(body).not.toContain("stack");
  });
});
