import type { Account, NextAuthConfig, Profile, User } from "next-auth";
import Google from "next-auth/providers/google";

import {
  syncGoogleAccount,
  type GoogleAccountInput,
} from "@/db/auth-accounts";

import {
  getValidGoogleToken,
  storeInitialGoogleToken,
} from "./google-oauth-token";

function optionalProfileValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function toGoogleAccountInput(
  account: Account,
  profile?: Profile,
  user?: User
): GoogleAccountInput {
  return {
    providerAccountId: account.providerAccountId,
    email: optionalProfileValue(profile?.email) ?? user?.email,
    name: optionalProfileValue(profile?.name) ?? user?.name,
    imageUrl: optionalProfileValue(profile?.picture) ?? user?.image,
    grantedScope: account.scope,
  };
}

const authConfig: NextAuthConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      authorization: {
        params: {
          access_type: "offline",
          prompt: "consent",
          scope:
            "openid email profile https://www.googleapis.com/auth/youtube.readonly",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/",
  },
  callbacks: {
    async signIn({ account, profile, user }) {
      if (!account || account.provider !== "google") return false;

      const persistedUser = await syncGoogleAccount(
        toGoogleAccountInput(account, profile, user)
      );
      return persistedUser.status === "active";
    },
    async jwt({ token, account, profile, user }) {
      if (account) {
        if (account.provider !== "google") {
          throw new Error("Unsupported OAuth provider.");
        }

        const persistedUser = await syncGoogleAccount(
          toGoogleAccountInput(account, profile, user)
        );
        if (persistedUser.status !== "active") {
          throw new Error("User account is unavailable.");
        }

        token.internalUserId = persistedUser.userId;
        token.accountStatus = persistedUser.status;
        token.sessionVersion = persistedUser.sessionVersion;
        storeInitialGoogleToken(token, account);

        if (profile && "picture" in profile) {
          token.picture = profile.picture;
        }

        return token;
      }

      const googleToken = await getValidGoogleToken(token);

      if (googleToken.status === "success") {
        token.accessToken = googleToken.accessToken;
        token.accessTokenExpiresAt = googleToken.accessTokenExpiresAt;
        token.refreshToken = googleToken.refreshToken ?? token.refreshToken;
        token.googleTokenError = undefined;
      } else {
        token.accessToken = undefined;
        token.googleTokenError =
          googleToken.status === "reauthentication_required"
            ? "ReauthenticationRequired"
            : googleToken.status === "configuration_error"
              ? "ConfigurationError"
              : googleToken.timedOut
                ? "RefreshTimeout"
                : "RefreshAccessTokenError";
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        if (
          token.internalUserId &&
          token.accountStatus === "active" &&
          typeof token.internalUserId === "string"
        ) {
          session.user.id = token.internalUserId;
        }

        if (token.picture && typeof token.picture === "string") {
          session.user.image = token.picture;
        }
      }

      return session;
    },
  },
};

export default authConfig;
