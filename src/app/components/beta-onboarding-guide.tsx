"use client";

import { useEffect, useState } from "react";

export const BETA_ONBOARDING_DISMISSED_KEY =
  "actustube.betaOnboardingDismissed";

export function BetaOnboardingGuide({
  analysisHistoryCount,
}: {
  analysisHistoryCount: number | null;
}) {
  const [storageChecked, setStorageChecked] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(
        window.localStorage.getItem(BETA_ONBOARDING_DISMISSED_KEY) === "true"
      );
    } catch {
      setDismissed(false);
    } finally {
      setStorageChecked(true);
    }
  }, []);

  function dismissGuide() {
    setDismissed(true);
    try {
      window.localStorage.setItem(
        BETA_ONBOARDING_DISMISSED_KEY,
        JSON.stringify(true)
      );
    } catch {
      // Storage can be blocked. Session-only dismissal is still safe.
    }
  }

  if (!storageChecked || dismissed || analysisHistoryCount !== 0) return null;

  return (
    <section
      className="beta-onboarding"
      aria-labelledby="beta-onboarding-title"
    >
      <div className="beta-onboarding__header">
        <div>
          <p className="beta-onboarding__eyebrow">First steps</p>
          <h2 id="beta-onboarding-title">はじめてのActusTube</h2>
        </div>
        <button
          type="button"
          className="beta-onboarding__close"
          onClick={dismissGuide}
          aria-label="初回利用ガイドを閉じる"
        >
          閉じる
        </button>
      </div>
      <ol className="beta-onboarding__steps">
        <li>
          <span aria-hidden="true">1</span>
          <p>Googleアカウントで所有チャンネルを確認</p>
        </li>
        <li>
          <span aria-hidden="true">2</span>
          <p>分析ボタンで通常動画とShortsを取得・分析</p>
        </li>
        <li>
          <span aria-hidden="true">3</span>
          <p>AI提案を基に改善項目を作成</p>
        </li>
      </ol>
    </section>
  );
}
