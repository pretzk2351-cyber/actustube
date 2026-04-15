import NextAuth from "next-auth";
import authConfig from "./src/app/lib/auth";

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);