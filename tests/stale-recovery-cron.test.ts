import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recoveryState = vi.hoisted(() => ({ recover: vi.fn() }));

vi.mock("@/app/lib/stale-reservation-recovery", () => ({
  SCHEDULED_RECOVERY_BATCH_SIZE: 100,
  recoverExpiredUsageReservations: recoveryState.recover,
}));

let cronGet: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const route = await import(
    "@/app/api/internal/recover-stale-reservations/route"
  );
  cronGet = route.GET;
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret-at-least-16-characters");
  recoveryState.recover.mockResolvedValue({ recovered: 2 });
});

function request(authorization?: string) {
  return new Request(
    "http://localhost/api/internal/recover-stale-reservations",
    { headers: authorization ? { authorization } : undefined }
  );
}

describe("stale reservation recovery cron", () => {
  it("fails closed when CRON_SECRET is missing or too short", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const missing = await cronGet(request());
    vi.stubEnv("CRON_SECRET", "too-short");
    const short = await cronGet(request("Bearer too-short"));

    expect(missing.status).toBe(503);
    expect(short.status).toBe(503);
    expect(recoveryState.recover).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid authorization without DB access", async () => {
    const missing = await cronGet(request());
    const invalid = await cronGet(request("Bearer wrong-secret"));

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(recoveryState.recover).not.toHaveBeenCalled();
  });

  it("runs a bounded recovery and prevents response caching", async () => {
    const response = await cronGet(
      request("Bearer test-cron-secret-at-least-16-characters")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, recovered: 2 });
    expect(recoveryState.recover).toHaveBeenCalledWith(100);
  });

  it("sanitizes recovery failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recoveryState.recover.mockRejectedValue(
      new Error("postgresql://user:secret@example.test/database")
    );

    const response = await cronGet(
      request("Bearer test-cron-secret-at-least-16-characters")
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("STALE_RESERVATION_RECOVERY_FAILED");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("secret@example");
    expect(log).toHaveBeenCalledWith("stale-reservation-recovery failed", {
      errorName: "Error",
    });
  });
});
