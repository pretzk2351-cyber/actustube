import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createWeeklyCycleNotice } from "@/app/lib/weekly-cycle-notice";

function readProjectFile(relativePath: string) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8"
  );
}

const componentSource = readProjectFile(
  "src/app/components/weekly-improvement-cycle.tsx"
);
const statusPanelSource = readProjectFile(
  "src/app/components/ui-foundation.tsx"
);

describe("weekly improvement cycle notices", () => {
  it.each([
    "週次改善サイクルを読み込めませんでした。",
    "改善項目を保存できませんでした。",
    "改善項目を更新できませんでした。",
    "履歴の続きを読み込めませんでした。",
  ])("creates an error notice for the %s failure", (message) => {
    expect(createWeeklyCycleNotice("error", message)).toEqual({
      message,
      tone: "error",
    });
  });

  it.each([
    "今週の改善項目を保存しました。",
    "改善項目を更新しました。",
    "改善結果を保存しました。",
  ])("creates a success notice for %s", (message) => {
    expect(createWeeklyCycleNotice("success", message)).toEqual({
      message,
      tone: "success",
    });
  });

  it("replaces an error with one success notice", () => {
    let notice = createWeeklyCycleNotice("error", "更新に失敗しました。");
    notice = createWeeklyCycleNotice("success", "更新しました。");

    expect(notice).toEqual({ message: "更新しました。", tone: "success" });
  });

  it("replaces a success with one error notice", () => {
    let notice = createWeeklyCycleNotice("success", "保存しました。");
    notice = createWeeklyCycleNotice("error", "保存できませんでした。");

    expect(notice).toEqual({
      message: "保存できませんでした。",
      tone: "error",
    });
  });

  it("uses the notice tone when rendering the shared status panel", () => {
    expect(componentSource).toContain(
      '<StatusPanel tone={notice.tone} title={notice.message} />'
    );
    expect(componentSource).not.toContain('<StatusPanel tone="info"');
    expect(componentSource).not.toContain("setMessage(");
  });

  it("keeps error notices assertive and success notices non-alerting", () => {
    expect(statusPanelSource).toContain(
      'role={tone === "error" ? "alert" : "status"}'
    );
    expect(statusPanelSource).toContain(
      'aria-live={tone === "error" ? "assertive" : "polite"}'
    );
  });

  it("routes every component failure through the error tone and clears stale notices", () => {
    expect(
      componentSource.match(/createWeeklyCycleNotice\(\s*"error"/g)
    ).toHaveLength(10);
    expect(componentSource.match(/setNotice\(null\)/g)).toHaveLength(4);
  });

  it("keeps saving guards and disabled controls in place", () => {
    expect(componentSource.match(/setSaving\(true\)/g)).toHaveLength(2);
    expect(componentSource).toContain(
      "disabled={saving || !newTitle.trim()}"
    );
    expect(componentSource).toContain(
      "disabled={saving || !editTitle.trim()}"
    );
    expect(componentSource).toContain(
      "disabled={saving || !editTitle.trim() || !resultNote.trim()}"
    );
  });
});
