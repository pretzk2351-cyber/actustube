import type { JWT } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGoogleTokenCache,
  getValidGoogleToken,
} from "@/app/lib/google-oauth-token";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const subjects = new Set<string>();
let subjectSequence = 0;

function createToken(overrides: Partial<JWT> = {}): JWT {
  subjectSequence += 1;
  const sub = `test-user-${subjectSequence}`;
  subjects.add(sub);

  return {
    sub,
    accessToken: "test-access-token-old",
    refreshToken: "test-refresh-token-old",
    accessTokenExpiresAt: NOW_SECONDS - 1,
    ...overrides,
  };
}

function mockTokenResponse(
  body: Record<string, unknown>,
  status = 200
) {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockSuccessfulRefresh(
  overrides: Record<string, unknown> = {}
) {
  mockTokenResponse({
    access_token: "test-access-token-new",
    expires_in: 3_600,
    token_type: "Bearer",
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
});

afterEach(() => {
  for (const subject of subjects) clearGoogleTokenCache(subject);
  subjects.clear();
});

describe("getValidGoogleToken", () => {
  it("uses an access token that is valid beyond the refresh buffer", async () => {
    const token = createToken({
      accessTokenExpiresAt: NOW_SECONDS + 61,
    });

    const result = await getValidGoogleToken(token);

    expect(result).toEqual({
      status: "success",
      accessToken: "test-access-token-old",
      accessTokenExpiresAt: NOW_SECONDS + 61,
      refreshToken: "test-refresh-token-old",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes an access token with exactly 60 seconds remaining", async () => {
    mockSuccessfulRefresh();
    const token = createToken({
      accessTokenExpiresAt: NOW_SECONDS + 60,
    });

    const result = await getValidGoogleToken(token);

    expect(result).toMatchObject({
      status: "success",
      accessToken: "test-access-token-new",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired access token with the refresh token", async () => {
    mockSuccessfulRefresh();
    const token = createToken();

    const result = await getValidGoogleToken(token);

    expect(result).toEqual({
      status: "success",
      accessToken: "test-access-token-new",
      accessTokenExpiresAt: NOW_SECONDS + 3_600,
      refreshToken: "test-refresh-token-old",
    });

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(request?.method).toBe("POST");
    expect(String(request?.body)).toContain(
      "refresh_token=test-refresh-token-old"
    );
  });

  it("keeps the existing refresh token when Google omits a new one", async () => {
    mockSuccessfulRefresh();

    const result = await getValidGoogleToken(createToken());

    expect(result).toMatchObject({
      status: "success",
      refreshToken: "test-refresh-token-old",
    });
  });

  it("uses a new refresh token when Google returns one", async () => {
    mockSuccessfulRefresh({ refresh_token: "test-refresh-token-new" });

    const result = await getValidGoogleToken(createToken());

    expect(result).toMatchObject({
      status: "success",
      refreshToken: "test-refresh-token-new",
    });
  });

  it("requires reauthentication without contacting Google when refresh token is missing", async () => {
    const result = await getValidGoogleToken(
      createToken({ refreshToken: undefined })
    );

    expect(result).toEqual({ status: "reauthentication_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps invalid_grant to a safe reauthentication result", async () => {
    mockTokenResponse(
      {
        error: "invalid_grant",
        error_description: "raw Google response must not escape",
      },
      400
    );

    const result = await getValidGoogleToken(createToken());

    expect(result).toEqual({ status: "reauthentication_required" });
  });

  it("maps Google 5xx to a safe temporary service failure", async () => {
    mockTokenResponse(
      {
        error: "server_error",
        access_token: "raw-access-token-must-not-escape",
      },
      503
    );

    const result = await getValidGoogleToken(createToken());

    expect(result).toEqual({
      status: "temporarily_unavailable",
      timedOut: false,
    });
  });

  it("maps token endpoint timeout to a safe timeout result", async () => {
    const timeout = new Error("request included secret values");
    timeout.name = "TimeoutError";
    vi.mocked(fetch).mockRejectedValueOnce(timeout);

    const result = await getValidGoogleToken(createToken());

    expect(result).toEqual({
      status: "temporarily_unavailable",
      timedOut: true,
    });
  });

  it("coalesces concurrent refreshes for one user in a single process", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const token = createToken();

    const first = getValidGoogleToken(token);
    const second = getValidGoogleToken(token);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch?.(
      new Response(
        JSON.stringify({
          access_token: "test-access-token-new",
          expires_in: 3_600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose tokens, client secret, or raw Google details in failures", async () => {
    mockTokenResponse(
      {
        error: "server_error",
        error_description: "raw-google-description",
        access_token: "raw-access-token",
        refresh_token: "raw-refresh-token",
      },
      500
    );

    const result = await getValidGoogleToken(createToken());
    const serialized = JSON.stringify(result);

    expect(serialized).toBe(
      JSON.stringify({ status: "temporarily_unavailable", timedOut: false })
    );
    expect(serialized).not.toContain("raw-google-description");
    expect(serialized).not.toContain("test-google-client-secret");
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refresh-token");
  });

  it("reuses a refreshed access token on the next request", async () => {
    mockSuccessfulRefresh();
    const token = createToken();

    const first = await getValidGoogleToken(token);
    const second = await getValidGoogleToken({ ...token });

    expect(first).toEqual(second);
    expect(second).toMatchObject({
      status: "success",
      accessToken: "test-access-token-new",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
