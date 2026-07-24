import assert from "node:assert/strict";

import { neon } from "@neondatabase/serverless";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  console.log("Usage-limit integration test skipped: TEST_DATABASE_URL is not set.");
  process.exit(0);
}

const database = neon(testDatabaseUrl);
const createdUserIds = [];

async function createUser({
  status = "active",
  sessionVersion = 1,
  withPlan = true,
} = {}) {
  const rows = await database`
    INSERT INTO public.users (status, session_version)
    VALUES (${status}, ${sessionVersion})
    RETURNING id
  `;
  const userId = rows[0].id;
  createdUserIds.push(userId);

  if (withPlan) {
    await database`
      INSERT INTO public.user_plan_assignments (
        user_id,
        plan_code,
        status,
        source,
        starts_at
      )
      VALUES (
        ${userId}::uuid,
        'free',
        'active',
        'system',
        '2020-01-01T00:00:00Z'
      )
    `;
  }

  return userId;
}

async function reserve(userId, metric, now, sessionVersion = 1) {
  const rows = await database`
    SELECT *
    FROM public.reserve_usage_limits(
      ${userId}::uuid,
      ${sessionVersion}::integer,
      ${metric}::public.usage_metric,
      ${now}::timestamp with time zone
    )
  `;
  return rows[0];
}

async function reserveV2(userId, metric, now, sessionVersion = 1) {
  const rows = await database`
    SELECT *
    FROM public.reserve_usage_limits_v2(
      ${userId}::uuid,
      ${sessionVersion}::integer,
      ${metric}::public.usage_metric,
      ${now}::timestamp with time zone
    )
  `;
  return rows[0];
}

async function usageStatus(userId, now, sessionVersion = 1) {
  const rows = await database`
    SELECT *
    FROM public.get_usage_status_v1(
      ${userId}::uuid,
      ${sessionVersion}::integer,
      ${now}::timestamp with time zone
    )
  `;
  return rows[0];
}

async function bucketCounts(userId, metric) {
  return database`
    SELECT
      period_kind AS "periodKind",
      used_count AS "usedCount",
      limit_snapshot AS "limitSnapshot"
    FROM public.user_usage_buckets
    WHERE user_id = ${userId}::uuid
      AND metric = ${metric}::public.usage_metric
    ORDER BY period_kind
  `;
}

async function release(userId, reservationId) {
  const rows = await database`
    SELECT *
    FROM public.release_usage_limits(
      ${reservationId}::uuid,
      ${userId}::uuid
    )
  `;
  return rows[0];
}

async function finalize(userId, reservationId) {
  const rows = await database`
    SELECT public.finalize_usage_reservation(
      ${reservationId}::uuid,
      ${userId}::uuid
    ) AS finalized
  `;
  return rows[0].finalized;
}

async function recover(staleBefore, batchSize = 100) {
  const rows = await database`
    SELECT public.recover_stale_usage_reservations(
      ${staleBefore}::timestamp with time zone,
      ${batchSize}::integer
    ) AS recovered
  `;
  return rows[0].recovered;
}

async function run() {
  const releasedUser = await createUser();
  const pendingRelease = await reserve(
    releasedUser,
    "channel_analysis",
    "2026-07-18T12:00:00.000Z"
  );
  assert.equal(pendingRelease.allowed, true);
  assert.ok(pendingRelease.reservation_id);
  assert.equal("effective_plan_id" in pendingRelease, false);
  assert.deepEqual(await release(releasedUser, pendingRelease.reservation_id), {
    released: true,
    daily_used: 0,
    monthly_used: 0,
  });
  assert.deepEqual(await release(releasedUser, pendingRelease.reservation_id), {
    released: false,
    daily_used: null,
    monthly_used: null,
  });
  assert.deepEqual(await bucketCounts(releasedUser, "channel_analysis"), [
    { periodKind: "day", usedCount: 0, limitSnapshot: 2 },
    { periodKind: "month", usedCount: 0, limitSnapshot: 5 },
  ]);

  const finalizedUser = await createUser();
  const pendingFinalize = await reserve(
    finalizedUser,
    "ai_consult",
    "2026-07-18T12:00:00.000Z"
  );
  assert.equal(
    await finalize(finalizedUser, pendingFinalize.reservation_id),
    true
  );
  assert.equal(
    (await release(finalizedUser, pendingFinalize.reservation_id)).released,
    false
  );
  assert.deepEqual(await bucketCounts(finalizedUser, "ai_consult"), [
    { periodKind: "day", usedCount: 1, limitSnapshot: 1 },
    { periodKind: "month", usedCount: 1, limitSnapshot: 3 },
  ]);

  const staleUser = await createUser();
  const staleReservation = await reserve(
    staleUser,
    "channel_analysis",
    "2026-07-18T12:00:00.000Z"
  );
  assert.equal(staleReservation.allowed, true);
  const concurrentRecoveries = await Promise.all([
    recover("2026-07-18T12:15:00.000Z", 10),
    recover("2026-07-18T12:15:00.000Z", 10),
  ]);
  assert.equal(
    concurrentRecoveries.reduce((total, recovered) => total + recovered, 0),
    1
  );
  assert.equal(await recover("2026-07-18T12:15:00.000Z", 10), 0);
  assert.equal(
    (await release(staleUser, staleReservation.reservation_id)).released,
    false
  );
  assert.deepEqual(await bucketCounts(staleUser, "channel_analysis"), [
    { periodKind: "day", usedCount: 0, limitSnapshot: 2 },
    { periodKind: "month", usedCount: 0, limitSnapshot: 5 },
  ]);

  const concurrentUser = await createUser();
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, () =>
      reserve(
        concurrentUser,
        "channel_analysis",
        "2026-07-18T12:00:00.000Z"
      )
    )
  );
  assert.equal(concurrent.filter((result) => result.allowed).length, 2);
  assert.deepEqual(await bucketCounts(concurrentUser, "channel_analysis"), [
    { periodKind: "day", usedCount: 2, limitSnapshot: 2 },
    { periodKind: "month", usedCount: 2, limitSnapshot: 5 },
  ]);

  const independentUser = await createUser();
  const independent = await Promise.all([
    reserve(
      independentUser,
      "channel_analysis",
      "2026-07-18T12:00:00.000Z"
    ),
    reserve(independentUser, "ai_consult", "2026-07-18T12:00:00.000Z"),
  ]);
  assert.equal(independent[0].allowed, true);
  assert.equal(independent[0].daily_limit, 2);
  assert.equal(independent[0].monthly_limit, 5);
  assert.equal(independent[1].allowed, true);
  assert.equal(independent[1].daily_limit, 1);
  assert.equal(independent[1].monthly_limit, 3);

  const snapshotUser = await createUser();
  const snapshotReservation = await reserveV2(
    snapshotUser,
    "channel_analysis",
    "2026-07-18T12:00:00.000Z"
  );
  assert.equal(snapshotReservation.allowed, true);
  assert.equal(snapshotReservation.effective_plan_id, "free");
  assert.equal(snapshotReservation.canonical_plan_key, "free");
  assert.equal(snapshotReservation.plan_kind, "free");
  assert.equal(snapshotReservation.regular_video_limit, 10);
  assert.equal(snapshotReservation.shorts_video_limit, 10);
  assert.equal(snapshotReservation.plan_from_assignment, true);
  assert.equal(
    (await release(snapshotUser, snapshotReservation.reservation_id)).released,
    true
  );

  const monthlyUser = await createUser();
  for (let day = 1; day <= 5; day += 1) {
    const result = await reserve(
      monthlyUser,
      "channel_analysis",
      `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`
    );
    assert.equal(result.allowed, true);
  }
  const monthlyDenied = await reserve(
    monthlyUser,
    "channel_analysis",
    "2026-08-06T12:00:00.000Z"
  );
  assert.equal(monthlyDenied.denial_reason, "monthly_limit_reached");

  const versionedUser = await createUser({ sessionVersion: 2 });
  assert.equal(
    (
      await reserve(
        versionedUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z",
        1
      )
    ).denial_reason,
    "session_version_mismatch"
  );

  const inactiveUser = await createUser({ status: "suspended" });
  assert.equal(
    (
      await reserve(
        inactiveUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z"
      )
    ).denial_reason,
    "user_inactive"
  );
  await database`
    UPDATE public.users
    SET status = 'deleted'
    WHERE id = ${inactiveUser}::uuid
  `;
  assert.equal(
    (
      await reserve(
        inactiveUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z"
      )
    ).denial_reason,
    "user_inactive"
  );

  const planlessUser = await createUser({ withPlan: false });
  assert.deepEqual(await bucketCounts(planlessUser, "channel_analysis"), []);
  const planlessStatus = await usageStatus(
    planlessUser,
    "2026-09-01T12:00:00.000Z"
  );
  assert.equal(planlessStatus.available, true);
  assert.equal(planlessStatus.canonical_plan_key, "free");
  assert.equal(planlessStatus.plan_from_assignment, false);
  assert.equal(planlessStatus.analysis_daily_used, 0);
  assert.equal(planlessStatus.analysis_daily_remaining, 2);
  assert.equal(planlessStatus.analysis_monthly_used, 0);
  assert.equal(planlessStatus.analysis_monthly_remaining, 5);
  assert.equal(planlessStatus.ai_daily_used, 0);
  assert.equal(planlessStatus.ai_daily_remaining, 1);
  assert.equal(planlessStatus.ai_monthly_used, 0);
  assert.equal(planlessStatus.ai_monthly_remaining, 3);
  assert.deepEqual(await bucketCounts(planlessUser, "channel_analysis"), []);

  const fallbackReservation = await reserveV2(
    planlessUser,
    "channel_analysis",
    "2026-09-01T12:00:00.000Z"
  );
  assert.equal(fallbackReservation.allowed, true);
  assert.equal(fallbackReservation.plan_from_assignment, false);
  assert.equal(
    (await release(planlessUser, fallbackReservation.reservation_id)).released,
    true
  );

  console.log({
    concurrentAllowed: 2,
    channelAnalysisLimits: { daily: 2, monthly: 5 },
    aiConsultLimits: { daily: 1, monthly: 3 },
    stateDenialsVerified: true,
    oneTimeReleaseVerified: true,
    successfulFinalizationVerified: true,
    staleRecoveryVerified: true,
    readOnlyStatusVerified: true,
    activeAssignmentAndFreeFallbackVerified: true,
    versionedPlanSnapshotVerified: true,
    legacyReservationContractVerified: true,
  });
}

try {
  await run();
} catch (error) {
  console.error({
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
} finally {
  for (const userId of createdUserIds) {
    try {
      await database`
        DELETE FROM public.users
        WHERE id = ${userId}::uuid
      `;
    } catch {
      process.exitCode = 1;
    }
  }
}
