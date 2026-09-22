import { describe, expect, it, vi } from "vitest";

import nextConfig from "../next.config";

const ENVIRONMENT_VARIABLE = "ACTUSTUBE_STAGING_NOINDEX";

async function resolveHeaders() {
  if (typeof nextConfig.headers !== "function") {
    throw new Error("Next.js headers configuration is missing.");
  }

  return nextConfig.headers();
}

describe("staging-only search indexing guard", () => {
  it("sets the exact X-Robots-Tag on every path only for exact value 1", async () => {
    vi.stubEnv(ENVIRONMENT_VARIABLE, "1");

    await expect(resolveHeaders()).resolves.toEqual([
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, noarchive, nosnippet",
          },
        ],
      },
    ]);
  });

  it.each([
    { label: "undefined", value: undefined },
    { label: "empty", value: "" },
    { label: "zero", value: "0" },
    { label: "false", value: "false" },
    { label: "other", value: "true" },
    { label: "whitespace-padded", value: " 1 " },
  ])("does not alter Production-equivalent behavior for $label", async ({ value }) => {
    vi.stubEnv(ENVIRONMENT_VARIABLE, value);

    await expect(resolveHeaders()).resolves.toEqual([]);
  });
});
