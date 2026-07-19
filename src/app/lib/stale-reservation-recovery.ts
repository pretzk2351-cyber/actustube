import "server-only";

import { recoverStaleUsageReservations } from "@/db/usage-limits";

export const STALE_RESERVATION_AGE_MS = 15 * 60 * 1_000;
export const OPPORTUNISTIC_RECOVERY_BATCH_SIZE = 25;
export const SCHEDULED_RECOVERY_BATCH_SIZE = 100;

export async function recoverExpiredUsageReservations(
  batchSize: number,
  now = new Date()
) {
  return recoverStaleUsageReservations({
    staleBefore: new Date(now.getTime() - STALE_RESERVATION_AGE_MS),
    batchSize,
  });
}
