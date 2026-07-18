import type { JWT } from "next-auth/jwt";
import { encode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncGoogleAccount } from "@/db/auth-accounts";
import authConfig from "@/app/lib/auth";
import { clearGoogleTokenCache } from "@/app/lib/google-oauth-token";

vi.mock("@/db/auth-accounts", () => ({
  syncGoogleAccount: vi.fn(),
}));

const JWT_TEST_SUBJECT = "auth-config-jwt-test-user";
const INTERNAL_USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
  vi.stubEnv("AUTH_SECRET", "test-auth-secret");
  vi.mocked(syncGoogleAccount).mockResolvedValue({
    userId: INTERNAL_USER_ID,
    status: "active",
    sessionVersion: 1,
  });
});

afterEach(() => {
  clearGoogleTokenCache(INTERNAL_USER_ID);
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
        internalUserId: INTERNAL_USER_ID,
        accountStatus: "active",
        sessionVersion: 1,
        accessToken: "session-access-token-must-stay-server-side",
        refreshToken: "session-refresh-token-must-stay-server-side",
        accessTokenExpiresAt: 4_070_908_800,
      },
    });

    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({
      user: { id: INTERNAL_USER_ID, name: "Test User" },
    });
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("session-access-token");
    expect(serialized).not.toContain("session-refresh-token");
    expect(serialized).not.toContain("test-user-id");
    expect(serialized).not.toContain("\"sub\"");
  });

  it("does not expose token.sub or OAuth tokens from /api/auth/session", async () => {
    const cookieName = "authjs.session-token";
    const sessionToken = await encode({
      secret: "test-auth-secret",
      salt: cookieName,
      token: {
        sub: "route-authjs-subject-must-stay-server-side",
        internalUserId: INTERNAL_USER_ID,
        accountStatus: "active",
        sessionVersion: 1,
        name: "Test User",
        email: "user@example.test",
        accessToken: "route-access-token-must-stay-server-side",
        refreshToken: "route-refresh-token-must-stay-server-side",
        accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      },
    });
    const { Auth } = await import("@auth/core");
    const response = await Auth(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: `${cookieName}=${sessionToken}` },
      }),
      {
        ...authConfig,
        basePath: "/api/auth",
        secret: "test-auth-secret",
        trustHost: true,
      }
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ user: { id: INTERNAL_USER_ID } });
    expect(response.headers.get("set-cookie")).toContain(`${cookieName}=`);
    expect(serialized).not.toContain("route-authjs-subject");
    expect(serialized).not.toContain("route-access-token");
    expect(serialized).not.toContain("route-refresh-token");
    expect(serialized).not.toContain("\"sub\"");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
  });

  it("upserts the Google identity and accepts an active user during sign-in", async () => {
    const signInCallback = authConfig.callbacks?.signIn as unknown as (args: {
      account: {
        provider: string;
        providerAccountId: string;
        scope: string;
      };
      profile: { email: string; name: string; picture: string };
      user: { id: string; email: string; name: string; image: string };
    }) => Promise<boolean>;

    const accepted = await signInCallback({
      account: {
        provider: "google",
        providerAccountId: "google-provider-account-123",
        scope: "openid email profile youtube.readonly",
      },
      profile: {
        email: "user@example.test",
        name: "Test User",
        picture: "https://example.test/avatar.png",
      },
      user: {
        id: "oauth-profile-id-not-used-as-db-id",
        email: "user@example.test",
        name: "Test User",
        image: "https://example.test/avatar.png",
      },
    });

    expect(accepted).toBe(true);
    expect(syncGoogleAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: "google-provider-account-123",
        email: "user@example.test",
      })
    );
  });

  it.each(["suspended", "deleted"] as const)(
    "rejects a %s user during sign-in",
    async (status) => {
      vi.mocked(syncGoogleAccount).mockResolvedValueOnce({
        userId: INTERNAL_USER_ID,
        status,
        sessionVersion: 2,
      });
      const signInCallback = authConfig.callbacks?.signIn as unknown as (
        args: {
          account: { provider: string; providerAccountId: string };
          profile: Record<string, never>;
          user: { id: string };
        }
      ) => Promise<boolean>;

      const accepted = await signInCallback({
        account: {
          provider: "google",
          providerAccountId: "google-provider-account-123",
        },
        profile: {},
        user: { id: "oauth-profile-id" },
      });

      expect(accepted).toBe(false);
    }
  );

  it("keeps providerAccountId, token.sub, and the internal user ID distinct", async () => {
    const jwtCallback = authConfig.callbacks?.jwt as unknown as (args: {
      token: JWT;
      account: {
        provider: string;
        providerAccountId: string;
        access_token: string;
        refresh_token: string;
        expires_at: number;
        scope: string;
      };
      profile: { email: string; name: string; picture: string };
      user: { id: string; email: string; name: string; image: string };
    }) => Promise<JWT>;

    const result = await jwtCallback({
      token: { sub: "provider-subject" },
      account: {
        provider: "google",
        providerAccountId: "google-provider-account-123",
        access_token: "jwt-access-token",
        refresh_token: "jwt-refresh-token",
        expires_at: 4_070_908_800,
        scope: "openid email profile youtube.readonly",
      },
      profile: {
        email: "user@example.test",
        name: "Test User",
        picture: "https://example.test/avatar.png",
      },
      user: {
        id: "oauth-profile-id-not-used-as-db-id",
        email: "user@example.test",
        name: "Test User",
        image: "https://example.test/avatar.png",
      },
    });

    expect(result.internalUserId).toBe(INTERNAL_USER_ID);
    expect(result.accountStatus).toBe("active");
    expect(result.sessionVersion).toBe(1);
    expect(result.sub).toBe("provider-subject");
    expect(syncGoogleAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: "google-provider-account-123",
      })
    );
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
        internalUserId: INTERNAL_USER_ID,
        accountStatus: "active",
        accessToken: "jwt-access-token-old",
        refreshToken: "jwt-refresh-token-old",
        accessTokenExpiresAt: 1,
      },
      account: null,
    });

    expect(result.accessToken).toBe("jwt-access-token-new");
    expect(result.refreshToken).toBe("jwt-refresh-token-new");
    expect(result.googleTokenError).toBeUndefined();

    const sessionCallback = authConfig.callbacks?.session as unknown as (
      args: {
        session: {
          user: { name: string; email: string; image: null; id?: string };
          expires: string;
        };
        token: JWT;
      }
    ) => Promise<{ user: { id?: string } }>;
    const session = await sessionCallback({
      session: {
        user: {
          name: "Test User",
          email: "user@example.test",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
      token: result,
    });

    expect(session.user.id).toBe(INTERNAL_USER_ID);
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
        internalUserId: INTERNAL_USER_ID,
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
