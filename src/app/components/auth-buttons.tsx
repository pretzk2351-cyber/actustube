"use client";

import { signIn, signOut } from "next-auth/react";

export function SignInButton() {
  return (
    <button
      type="button"
      onClick={() => signIn("google")}
      className="auth-button auth-button--primary"
    >
      Googleでログイン
    </button>
  );
}

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut()}
      className="auth-button auth-button--secondary"
    >
      ログアウト
    </button>
  );
}
