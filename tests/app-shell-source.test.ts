import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("app shell route and roadmap sources", () => {
  it("guards the authenticated app layout and keeps the public root separate", () => {
    const layout = readFileSync(resolve("src/app/app/layout.tsx"), "utf8");
    const root = readFileSync(resolve("src/app/page.tsx"), "utf8");
    expect(layout).toContain("await auth()");
    expect(layout).toContain('redirect("/")');
    expect(root).toContain('href="/app/dashboard"');
    expect(root).not.toContain("<YouTubeForm");
  });

  it("defines every requested workspace route and responsive breakpoint", () => {
    for (const route of ["dashboard", "analysis", "consult", "improvements", "history", "plan", "settings", "support"]) {
      expect(readFileSync(resolve(`src/app/app/${route}/page.tsx`), "utf8")).toContain("View");
    }
    const css = readFileSync(resolve("src/app/globals.css"), "utf8");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("@media (max-width: 390px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("documents the extension only as a future, user-controlled proposal", () => {
    const roadmap = readFileSync(resolve("docs/VIDIQ_INSPIRED_PRODUCT_ROADMAP.md"), "utf8");
    expect(roadmap).toContain("Chrome拡張機能は今回実装しません");
    expect(roadmap).toContain("YouTube側の保存ボタンは本人が押す");
    expect(roadmap).toContain("AI自由質問APIまたは新しいAI生成API");
  });
});
