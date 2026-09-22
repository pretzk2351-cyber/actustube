// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BETA_ONBOARDING_DISMISSED_KEY,
  BetaOnboardingGuide,
} from "@/app/components/beta-onboarding-guide";

describe("beta onboarding guide", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows three steps only when analysis history is empty", async () => {
    const { rerender } = render(
      createElement(BetaOnboardingGuide, { analysisHistoryCount: 0 })
    );

    expect(await screen.findByText("はじめてのActusTube")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    rerender(createElement(BetaOnboardingGuide, { analysisHistoryCount: 1 }));
    expect(screen.queryByText("はじめてのActusTube")).toBeNull();
  });

  it("dismisses with an accessible button and stores only a boolean", async () => {
    render(createElement(BetaOnboardingGuide, { analysisHistoryCount: 0 }));

    const close = await screen.findByRole("button", {
      name: "初回利用ガイドを閉じる",
    });
    expect(close.tagName).toBe("BUTTON");
    fireEvent.click(close);

    await waitFor(() =>
      expect(screen.queryByText("はじめてのActusTube")).toBeNull()
    );
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.key(0)).toBe(BETA_ONBOARDING_DISMISSED_KEY);
    expect(window.localStorage.getItem(BETA_ONBOARDING_DISMISSED_KEY)).toBe(
      "true"
    );
    expect(JSON.stringify(window.localStorage)).not.toMatch(
      /channel|token|oauth|UC[a-z0-9_-]{22}/i
    );
  });

  it("does not reappear after the stored dismissal", async () => {
    window.localStorage.setItem(BETA_ONBOARDING_DISMISSED_KEY, "true");

    render(createElement(BetaOnboardingGuide, { analysisHistoryCount: 0 }));

    await waitFor(() =>
      expect(screen.queryByText("はじめてのActusTube")).toBeNull()
    );
  });

  it("keeps working when localStorage access is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    render(createElement(BetaOnboardingGuide, { analysisHistoryCount: 0 }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "初回利用ガイドを閉じる",
      })
    );
    await waitFor(() =>
      expect(screen.queryByText("はじめてのActusTube")).toBeNull()
    );
  });
});
