import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

import {
  getValidGoogleToken,
  storeInitialGoogleToken,
} from "./google-oauth-token";

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
    async jwt({ token, account, profile }) {
      if (account) {
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
        if (token.sub) {
          session.user.id = token.sub;
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
