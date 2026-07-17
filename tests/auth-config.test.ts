import type { JWT } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authConfig from "@/app/lib/auth";
import { clearGoogleTokenCache } from "@/app/lib/google-oauth-token";

const JWT_TEST_SUBJECT = "auth-config-jwt-test-user";

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
});

afterEach(() => {
  clearGoogleTokenCache(JWT_TEST_SUBJECT);
});

describe("Auth.js configuration", () => {
  it("keeps offline YouTube read-only authorization configured", () => {
    const provider = authConfig.providers[0] as {
      options?: { authorization?: { params?: Record<string, string> } };
    };
    const params = provider.options?.authorization?.params;

    expect(params?.access_type).toBe("offline");
    expect(params?.prompt).toBe("consent");
    expect(params?.scope).toContain(
      "https://www.googleapis.com/auth/youtube.readonly"
    );
  });

  it("does not expose OAuth tokens through the session callback", async () => {
    const sessionCallback = authConfig.callbacks?.session as unknown as (args: {
      session: {
        user: { name: string; email: string; image: string | null; id?: string };
        expires: string;
      };
      token: JWT;
    }) => Promise<Record<string, unknown>>;

    const result = await sessionCallback({
      session: {
        user: {
          name: "Test User",
          email: "user@example.test",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
      token: {
        sub: "test-user-id",
        accessToken: "session-access-token-must-stay-server-side",
        refreshToken: "session-refresh-token-must-stay-server-side",
        accessTokenExpiresAt: 4_070_908_800,
      },
    });

    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({
      user: { id: "test-user-id", name: "Test User" },
    });
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("session-access-token");
    expect(serialized).not.toContain("session-refresh-token");
  });

  it("stores a new refresh token returned through the JWT callback", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "jwt-access-token-new",
          refresh_token: "jwt-refresh-token-new",
          expires_in: 3_600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const jwtCallback = authConfig.callbacks?.jwt as unknown as (args: {
      token: JWT;
      account: null;
    }) => Promise<JWT>;

    const result = await jwtCallback({
      token: {
        sub: JWT_TEST_SUBJECT,
        accessToken: "jwt-access-token-old",
        refreshToken: "jwt-refresh-token-old",
        accessTokenExpiresAt: 1,
      },
      account: null,
    });

    expect(result.accessToken).toBe("jwt-access-token-new");
    expect(result.refreshToken).toBe("jwt-refresh-token-new");
    expect(result.googleTokenError).toBeUndefined();
  });

  it("preserves the existing refresh token when the JWT refresh response omits it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "jwt-access-token-new",
          expires_in: 3_600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const jwtCallback = authConfig.callbacks?.jwt as unknown as (args: {
      token: JWT;
      account: null;
    }) => Promise<JWT>;

    const result = await jwtCallback({
      token: {
        sub: JWT_TEST_SUBJECT,
        accessToken: "jwt-access-token-old",
        refreshToken: "jwt-refresh-token-old",
        accessTokenExpiresAt: 1,
      },
      account: null,
    });

    expect(result.accessToken).toBe("jwt-access-token-new");
    expect(result.refreshToken).toBe("jwt-refresh-token-old");
    expect(result.googleTokenError).toBeUndefined();
  });
});
