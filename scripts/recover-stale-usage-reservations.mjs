import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.RECOVERY_DATABASE_URL;
const staleAfterMinutes = Number(process.env.STALE_RESERVATION_MINUTES ?? "15");
const batchSize = Number(process.env.STALE_RESERVATION_BATCH_SIZE ?? "100");

if (!databaseUrl) {
  console.error("Stale reservation recovery skipped: RECOVERY_DATABASE_URL is not set.");
  process.exitCode = 1;
} else if (
  !Number.isInteger(staleAfterMinutes) ||
  staleAfterMinutes < 5 ||
  staleAfterMinutes > 1440 ||
  !Number.isInteger(batchSize) ||
  batchSize < 1 ||
  batchSize > 500
) {
  console.error("Stale reservation recovery configuration is invalid.");
  process.exitCode = 1;
} else {
  const database = neon(databaseUrl);
  const staleBefore = new Date(Date.now() - staleAfterMinutes * 60_000);

  try {
    const rows = await database`
      SELECT public.recover_stale_usage_reservations(
        ${staleBefore.toISOString()}::timestamp with time zone,
        ${batchSize}::integer
      ) AS recovered
    `;
    const recovered = rows[0]?.recovered;
    if (!Number.isSafeInteger(recovered) || recovered < 0 || recovered > batchSize) {
      throw new Error("Invalid recovery result.");
    }
    console.log({ recovered, batchSize, staleAfterMinutes });
  } catch {
    console.error("Stale reservation recovery failed.");
    process.exitCode = 1;
  }
}
