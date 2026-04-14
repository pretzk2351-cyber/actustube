"use client";

import { signIn, signOut } from "next-auth/react";

export function SignInButton() {
  return (
    <button
      onClick={() => signIn("google")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "10px",
        padding: "12px 18px",
        borderRadius: "12px",
        border: "1px solid #d90429",
        backgroundColor: "#d90429",
        color: "#ffffff",
        fontWeight: 800,
        fontSize: "14px",
        cursor: "pointer",
      }}
    >
      Googleでログイン
    </button>
  );
}

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut()}
      style={{
        padding: "10px 14px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.5)",
        backgroundColor: "transparent",
        color: "#ffffff",
        fontWeight: 700,
        fontSize: "13px",
        cursor: "pointer",
      }}
    >
      ログアウト
    </button>
  );
}